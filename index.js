// ----------------------------------------------------------------
// 1. ライブラリの読み込み
// ----------------------------------------------------------------
require('dotenv').config();
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
const userDatabase = {};


// ----------------------------------------------------------------
// 4. 各機能の部品 (ヘルパー関数)
// ----------------------------------------------------------------
const getRecipe = () => {
  const hour = new Date().getHours();
  let meal, mealType;
  if (hour >= 4 && hour < 11) { [meal, mealType] = ['朝ごはん', ['トースト', 'おにぎり', '卵かけご飯']]; }
  else if (hour >= 11 && hour < 16) { [meal, mealType] = ['お昼ごはん', ['うどん', 'パスタ', 'チャーハン']]; }
  else { [meal, mealType] = ['晩ごはん', ['カレー', '唐揚げ', '生姜焼き']]; }
  const recipe = mealType[Math.floor(Math.random() * mealType.length)];
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(recipe + ' 簡単 作り方')}`;
  return { type: 'text', text: `今日の${meal}は「${recipe}」なんてどう？\n作り方はこのあたりが参考になるかも！\n${searchUrl}` };
};

const getWeather = async (location) => {
  if (!location) return '地域が設定されてへんみたい。';
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${OPEN_WEATHER_API_KEY}&units=metric&lang=ja`;
    const response = await axios.get(url);
    const weather = response.data;
    const description = weather.weather[0].description;
    const temp = Math.round(weather.main.temp);
    const isRain = weather.weather[0].main.toLowerCase().includes('rain');
    let message = `今日の${location}の天気は「${description}」、気温は${temp}度くらいやで。`;
    if (isRain) { message += '\n雨が降りそうやから、傘持って行ったほうがええよ！☔'; }
    return message;
  } catch (error) { console.error('天気情報の取得に失敗しました:', error.response ? error.response.data : error.message); return 'ごめん、天気情報がうまく取れへんかったわ…'; }
};


// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
const client = new Client(config);

// 毎朝の通知 (ユーザーが設定した時間に合わせて実行する必要があるが、一旦8時で固定)
// TODO: 将来的にユーザーごとの設定時間(user.notificationTime)で動くように改良する
cron.schedule('0 8 * * *', async () => {
  console.log('朝の定期通知を実行します...');
  const todayIndex = new Date().getDay(); // 0:日曜, 1:月曜...

  for (const userId in userDatabase) {
    if (Object.hasOwnProperty.call(userDatabase, userId) && userDatabase[userId].setupState === 'complete') {
        const user = userDatabase[userId];
        let morningMessage = 'おはよー！朝やで！\n';

        const weatherInfo = await getWeather(user.location);
        morningMessage += `\n${weatherInfo}\n`;

        const garbageInfo = user.garbageDay[todayIndex];
        if (garbageInfo) {
          morningMessage += `\n今日は「${garbageInfo}」の日やで！忘れんといてや！🚮\n`;
        }
        
        if(user.trainLine) {
            morningMessage += `\n${user.trainLine}は、たぶん平常運転やで！いってらっしゃい！`;
        }

        client.pushMessage(userId, { type: 'text', text: morningMessage }).catch(err => console.error(err));
    }
  }
}, {
  timezone: "Asia/Tokyo"
});

// 毎分リマインダーをチェックする
cron.schedule('* * * * *', () => {
    const now = new Date();
    for (const userId in userDatabase) {
        if (Object.hasOwnProperty.call(userDatabase, userId)) {
            const user = userDatabase[userId];
            const dueReminders = [];
            
            user.reminders = user.reminders.filter(reminder => {
                if (new Date(reminder.date) <= now) {
                    dueReminders.push(reminder);
                    return false;
                }
                return true;
            });

            dueReminders.forEach(reminder => {
                client.pushMessage(userId, {
                    type: 'text',
                    text: `おかんやで！時間やで！\n\n「${reminder.task}」\n\n忘れたらあかんで！`
                }).catch(err => console.error(err));
            });
        }
    }
}, {
  timezone: "Asia/Tokyo"
});


// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }

  const userId = event.source.userId;

  if (event.type === 'follow' || (event.type === 'message' && !userDatabase[userId])) {
    userDatabase[userId] = {
      setupState: 'awaiting_location',
      location: null, notificationTime: null, trainLine: null, station: null,
      garbageDay: {}, reminders: [],
    };
    console.log(`新規ユーザーの初期設定を開始: ${userId}`);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '友達追加ありがとう！\nこれから毎日の生活がちょっと楽になるように手伝うで！\n\nまず、いくつか設定をさせてな。\n天気予報で使う地域はどこにする？\n（例：東京都豊島区）'
    });
  }

  const user = userDatabase[userId];
  const userText = event.message.text.trim();

  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location':
        user.location = userText;
        user.setupState = 'awaiting_time';
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${userText}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？\n（例：朝8時、7:30）` });
      case 'awaiting_time':
        user.notificationTime = userText;
        user.setupState = 'awaiting_line';
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、よく使う路線と駅名を教えてくれる？\n（例：山手線 池袋駅）` });
      case 'awaiting_line':
        const parts = userText.split(/[\s　]+/);
        user.trainLine = parts[0] || '';
        user.station = parts[1] || '';
        user.setupState = 'awaiting_garbage';
        return client.replyMessage(event.replyToken, { type: 'text', text: `覚えたで！路線は「${user.trainLine}」、駅は「${user.station}」やな。\n\n最後に、ゴミの日を教えてくれる？\n（例：「可燃ゴミは月曜日」みたいに、一つずつ教えてな。終わったら「おわり」と入力してや）` });
      case 'awaiting_garbage':
        if (userText === 'おわり') {
          user.setupState = 'complete';
          console.log(`ユーザーの初期設定が完了: ${userId}`, userDatabase[userId]);
          return client.replyMessage(event.replyToken, { type: 'text', text: '設定おおきに！これで全部や！\nこれからは毎朝通知するし、リマインダーとか献立も聞いてな！' });
        }
        const garbageMatch = userText.match(/(.+?ゴミ)は?(\S+?)曜日?/);
        if (garbageMatch) {
            const dayMap = { '日':0, '月':1, '火':2, '水':3, '木':4, '金':5, '土':6 };
            const garbageType = garbageMatch[1].trim();
            const dayOfWeek = garbageMatch[2];
            if (dayMap[dayOfWeek] !== undefined) {
              user.garbageDay[dayMap[dayOfWeek]] = garbageType;
              return client.replyMessage(event.replyToken, { type: 'text', text: `了解、「${garbageType}」が${dayOfWeek}曜日やね。他にもあったら教えてな。（終わったら「おわり」と入力）` });
            }
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、うまく聞き取れへんかったわ。「〇〇ゴミは△曜日」の形で教えてくれる？` });
    }
  }

  if (userText === 'リセット') {
      delete userDatabase[userId];
      return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。もう一度話しかけて、最初から設定し直してな。' });
  }
  if (userText.includes('ご飯') || userText.includes('ごはん')) { return client.replyMessage(event.replyToken, getRecipe()); }
  const reminderResult = chrono.ja.parse(userText);
  if (reminderResult.length > 0) {
    const reminderDate = reminderResult[0].start.date();
    const task = userText.replace(reminderResult[0].text, '').trim();
    if (task) {
        user.reminders.push({ date: reminderDate.toISOString(), task });
        return client.replyMessage(event.replyToken, { type: 'text', text: `あいよ！\n${reminderDate.toLocaleString('ja-JP')}に「${task}」やね。覚えとく！` });
    }
  }
  
  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
};


// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Okan AI is running!'));
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