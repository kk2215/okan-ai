// ----------------------------------------------------------------
// 1. ライブラリの読み込み
// ----------------------------------------------------------------
require('dotenv').config(); // .env ファイルから秘密の情報を読み込む
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const chrono = require('chrono-node');


// ----------------------------------------------------------------
// 2. 設定 (LINEや外部APIのキー)
// ----------------------------------------------------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OPEN_WEATHER_API_KEY = process.env.OPEN_WEATHER_API_KEY;


// ----------------------------------------------------------------
// 3. データベースの代わり (ユーザー情報を一時的に保存する場所)
// ----------------------------------------------------------------
// 注意: このままだとサーバーを再起動するとデータが消えてしまいます。
// 次のステップで、データが消えない本格的なデータベースに移行しましょう！
const userDatabase = {};


// ----------------------------------------------------------------
// 4. 各機能の部品 (ヘルパー関数)
// ----------------------------------------------------------------

/** 献立を提案する関数 */
const getRecipe = () => {
  const hour = new Date().getHours();
  let meal, mealType;
  if (hour >= 4 && hour < 11) { [meal, mealType] = ['朝ごはん', ['トースト', 'おにぎり', '卵かけご飯']]; }
  else if (hour >= 11 && hour < 16) { [meal, mealType] = ['お昼ごはん', ['うどん', 'パスタ', 'チャーハン']]; }
  else { [meal, mealType] = ['晩ごはん', ['カレー', '唐揚げ', '生姜焼き']]; }

  const recipe = mealType[Math.floor(Math.random() * mealType.length)];
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(recipe + ' 簡単 作り方')}`;

  return {
    type: 'text',
    text: `今日の${meal}は「${recipe}」なんてどう？\n作り方はYouTubeで見てみるとええよ！\n${searchUrl}`
  };
};

/** 天気情報を取得する関数 */
const getWeather = async (location) => {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${OPEN_WEATHER_API_KEY}&units=metric&lang=ja`;
    const response = await axios.get(url);
    const weather = response.data;
    const description = weather.weather[0].description;
    const temp = Math.round(weather.main.temp);
    const isRain = weather.weather[0].main.toLowerCase().includes('rain');

    let message = `今日の${location}の天気は「${description}」、気温は${temp}度くらいやで。`;
    if (isRain) {
      message += '\n雨が降りそうやから、傘持って行ったほうがええよ！☔';
    }
    return message;
  } catch (error) {
    console.error('天気情報の取得に失敗しました:', error);
    return 'ごめん、天気情報がうまく取れへんかったわ…';
  }
};


// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------

// 毎朝8時に、登録している全ユーザーに通知を送る
cron.schedule('0 8 * * *', async () => {
  console.log('朝の定期通知を実行します...');
  const todayIndex = new Date().getDay(); // 0:日曜, 1:月曜...

  for (const userId in userDatabase) {
    const user = userDatabase[userId];
    let morningMessage = 'おはよー！朝やで！\n';

    // 天気予報を追加
    const weatherInfo = await getWeather(user.location);
    morningMessage += `\n${weatherInfo}\n`;

    // ゴミの日を確認して追加
    const garbageInfo = user.garbageDay[todayIndex];
    if (garbageInfo) {
      morningMessage += `\n今日は「${garbageInfo}」の日やで！忘れんといてや！🚮\n`;
    }
    
    // 電車の運行状況 (今は固定メッセージ)
    // TODO: 将来的に運行情報を取得するAPIなどをここに組み込む
    morningMessage += `\n${user.trainLine}は、たぶん平常運転やで！いってらっしゃい！`;

    // ユーザーにプッシュメッセージを送信
    client.pushMessage(userId, { type: 'text', text: morningMessage });
  }
}, {
  timezone: "Asia/Tokyo"
});

// 毎分リマインダーをチェックする
cron.schedule('* * * * *', () => {
    const now = new Date();
    for (const userId in userDatabase) {
        const user = userDatabase[userId];
        const dueReminders = [];
        
        user.reminders = user.reminders.filter(reminder => {
            if (reminder.date <= now) {
                dueReminders.push(reminder);
                return false; // 処理したのでリストから削除
            }
            return true; // まだ期限ではないので残す
        });

        dueReminders.forEach(reminder => {
            client.pushMessage(userId, {
                type: 'text',
                text: `おかんやで！時間やで！\n\n「${reminder.task}」\n\n忘れたらあかんで！`
            });
        });
    }
}, {
    timezone: "Asia/Tokyo"
});


// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分
// ----------------------------------------------------------------
const lineClient = new Client(config);

const handleEvent = async (event) => {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const userText = event.message.text.trim();
  
  // ユーザーデータがなければ初期化
  if (!userDatabase[userId]) {
    userDatabase[userId] = {
      location: 'Tokyo',
      trainLine: '山手線',
      garbageDay: {}, // { 1: '可燃ゴミ', 4: '不燃ゴミ' } のような形式
      reminders: [], // { date: Dateオブジェクト, task: '内容' }
    };
    console.log(`新規ユーザーを初期化: ${userId}`);
  }

  // --- 機能の振り分け ---

  // 献立提案
  if (userText.includes('ご飯') || userText.includes('ごはん')) {
    return lineClient.replyMessage(event.replyToken, getRecipe());
  }

  // リマインダー登録
  const reminderResult = chrono.ja.parse(userText);
  if (reminderResult.length > 0) {
    const reminderDate = reminderResult[0].start.date();
    const task = userText.replace(reminderResult[0].text, '').trim();

    if (task) { // 日時だけでなく、内容もちゃんとあるか確認
        userDatabase[userId].reminders.push({ date: reminderDate, task });
        console.log(`リマインダー登録: ${userId}`, userDatabase[userId].reminders);
        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `あいよ！\n${reminderDate.toLocaleString('ja-JP')}に「${task}」やね。覚えとく！`,
        });
    }
  }

  // ゴミの日登録
  const garbageMatch = userText.match(/(.+ゴミ)は?(月|火|水|木|金|土|日)曜日?/);
  if (garbageMatch) {
    const dayMap = { '日':0, '月':1, '火':2, '水':3, '木':4, '金':5, '土':6 };
    const garbageType = garbageMatch[1].trim();
    const dayOfWeek = garbageMatch[2];
    userDatabase[userId].garbageDay[dayMap[dayOfWeek]] = garbageType;
    console.log(`ゴミの日登録: ${userId}`, userDatabase[userId].garbageDay);
    return lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `了解！${dayOfWeek}曜日は「${garbageType}」の日やね。`,
    });
  }

  // それ以外の会話
  return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
};


// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

app.listen(PORT, () => {
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});
