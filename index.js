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
const client = new Client(config);

// ----------------------------------------------------------------
// 3. データベースの代わり
// ----------------------------------------------------------------
const userDatabase = {};

// ----------------------------------------------------------------
// 4. 各機能の部品 (ヘルパー関数)
// ----------------------------------------------------------------

/** 住所情報をAPIで検索・検証する関数 */
const getGeoInfo = async (locationName) => {
  try {
    let response = await axios.get('https://geoapi.heartrails.com/api/json', { params: { method: 'getTowns', city: locationName } });
    if (response.data.response.location) {
      const loc = response.data.response.location[0];
      return { name: `${loc.prefecture}${loc.city}`, prefecture: loc.prefecture };
    }
    response = await axios.get('https://geoapi.heartrails.com/api/json', { params: { method: 'getPrefectures' } });
    const prefectures = response.data.response.prefecture;
    const foundPref = prefectures.find(p => p === locationName || p.replace(/[県府都]$/, '') === locationName);
    if (foundPref) { return { name: foundPref, prefecture: foundPref }; }
    return null;
  } catch (error) {
    console.error("地理情報APIエラー:", error);
    return null;
  }
};

/** 駅情報をAPIで検索・検証する関数 */
const findStation = async (stationName) => {
  try {
    const response = await axios.get('http://express.heartrails.com/api/json', { params: { method: 'getStations', name: stationName } });
    return response.data.response.station || [];
  } catch (error) {
    console.error("駅情報APIエラー:", error);
    return [];
  }
};

/** 路線選択のためのQuick Replyメッセージを作成する関数 */
const createLineSelectionReply = (lines) => {
  const items = lines.map(line => ({
    type: 'action',
    action: { type: 'message', label: line, text: line }
  }));
  return {
    type: 'text',
    text: '了解！その2駅やと、いくつか路線があるみたいやな。どれを一番よく使う？',
    quickReply: { items: items.slice(0, 13) }
  };
};

/** 献立を提案する関数 */
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

/** 天気情報を取得する関数 */
const getWeather = async (location) => {
  if (!location) return '地域が設定されてへんみたい。';
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${OPEN_WEATHER_API_KEY}&units=metric&lang=ja`;
    const response = await axios.get(url);
    const weather = response.data;
    const description = weather.weather[0].description;
    const temp = Math.round(weather.main.temp);
    const isRain = /雨/.test(weather.weather[0].description);
    let message = `今日の${location}の天気は「${description}」、気温は${temp}度くらいやで。`;
    if (isRain) { message += '\n雨が降るから傘持って行った方がいいよ！☔'; }
    return message;
  } catch (error) {
    console.error(`天気情報の取得に失敗: ${location}`, error.response ? error.response.data : error.message);
    return `ごめん、「${location}」の天気情報がうまく取れへんかったわ…`;
  }
};


// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
cron.schedule('0 8 * * *', async () => {
  console.log('朝の定期通知を実行します...');
  const todayIndex = new Date().getDay();
  for (const userId in userDatabase) {
    if (Object.hasOwnProperty.call(userDatabase, userId) && userDatabase[userId].setupState === 'complete') {
      const user = userDatabase[userId];
      let morningMessage = 'おはよー！朝やで！\n';
      const weatherInfo = await getWeather(user.location);
      morningMessage += `\n${weatherInfo}\n`;
      const garbageInfo = user.garbageDay[todayIndex];
      if (garbageInfo) { morningMessage += `\n今日は「${garbageInfo}」の日やで！忘れんといてや！🚮\n`; }
      if (user.trainLine) { morningMessage += `\n${user.trainLine}は、たぶん平常運転やで！いってらっしゃい！`; }
      client.pushMessage(userId, { type: 'text', text: morningMessage }).catch(err => console.error(err));
    }
  }
}, { timezone: "Asia/Tokyo" });

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
        client.pushMessage(userId, { type: 'text', text: `おかんやで！時間やで！\n\n「${reminder.task}」\n\n忘れたらあかんで！` }).catch(err => console.error(err));
      });
    }
  }
}, { timezone: "Asia/Tokyo" });


// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }
  const userId = event.source.userId;

  if (event.type === 'follow' || !userDatabase[userId]) {
    userDatabase[userId] = {
      setupState: 'awaiting_location', prefecture: null, location: null,
      notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
      garbageDay: {}, reminders: [],
    };
    return client.replyMessage(event.replyToken, { type: 'text', text: '友達追加ありがとう！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n**県名でも市区町村名でも、どっちでもええよ。**\n（例：東京都 or 豊島区）\n\nもちろん、「東京都豊島区」みたいに、詳しい方が情報の精度は上がるけどね！' });
  }

  const user = userDatabase[userId];
  const userText = event.message.text.trim();

  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location': {
        const geoData = await getGeoInfo(userText);
        if (!geoData) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その地域は見つけられへんかったわ。もう一度、正しい名前で教えてくれる？' }); }
        user.location = geoData.name;
        user.prefecture = geoData.prefecture;
        user.setupState = 'awaiting_time';
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      }
      case 'awaiting_time': {
        user.notificationTime = userText;
        user.setupState = 'awaiting_route';
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する経路を「〇〇駅から〇〇駅」のように教えてくれる？\n（例：池袋駅から新宿駅）` });
      }
      case 'awaiting_route': {
        const match = userText.match(/(.+?)駅?から(.+?)駅?/);
        if (!match) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、うまく聞き取れへんかった。「〇〇駅から〇〇駅」の形でもう一度教えてくれる？' }); }
        const departureName = match[1].trim();
        const arrivalName = match[2].trim();
        const departureStations = await findStation(departureName);
        const arrivalStations = await findStation(arrivalName);
        const departure = departureStations.find(s => s.prefecture === user.prefecture) || departureStations[0];
        const arrival = arrivalStations.find(s => s.prefecture === user.prefecture) || arrivalStations[0];
        if (!departure) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${departureName}」という駅が見つからへんかったわ。` });}
        if (!arrival) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${arrivalName}」という駅が見つからへんかったわ。` });}
        user.departureStation = departure;
        user.arrivalStation = arrival;
        const commonLines = departure.line.filter(line => arrival.line.includes(line));
        if (commonLines.length === 0) {
          user.setupState = 'awaiting_garbage';
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${departure.name}駅」と「${arrival.name}駅」は覚えたで。ただ、2駅を直接結ぶ路線は見つからへんかったわ…。\n\n最後に、ゴミの日を教えてくれる？` });
        } else if (commonLines.length === 1) {
          user.trainLine = commonLines[0];
          user.setupState = 'awaiting_garbage';
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${departure.name}駅」から「${arrival.name}駅」まで、「${user.trainLine}」を使うんやね。覚えたで！\n\n最後に、ゴミの日を教えてくれる？` });
        } else {
          user.setupState = 'awaiting_line_selection';
          return client.replyMessage(event.replyToken, createLineSelectionReply(commonLines));
        }
      }
      case 'awaiting_line_selection': {
        user.trainLine = userText;
        user.setupState = 'awaiting_garbage';
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${user.trainLine}」やね、覚えたで！\n\n最後に、ゴミの日を教えてくれる？\n（例：「可燃ゴミは月曜日」と一つずつ教えてな。終わったら「おわり」と入力してや）` });
      }
      case 'awaiting_garbage': {
        if (userText === 'おわり' || userText === 'なし') {
          user.setupState = 'complete';
          console.log(`ユーザーの初期設定が完了: ${userId}`, userDatabase[userId]);
          return client.replyMessage(event.replyToken, { type: 'text', text: '設定おおきに！これで全部や！\nこれからは毎朝通知するし、色々聞いてな！' });
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
