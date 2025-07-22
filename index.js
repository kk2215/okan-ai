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
  } catch (error) { console.error("地理情報APIエラー:", error); return null; }
};
const findStation = async (stationName) => {
  try {
    const response = await axios.get('http://express.heartrails.com/api/json', { params: { method: 'getStations', name: stationName } });
    return response.data.response.station || [];
  } catch (error) { console.error("駅情報APIエラー:", error); return []; }
};
const createLineSelectionReply = (lines) => {
  const items = lines.map(line => ({ type: 'action', action: { type: 'message', label: line, text: line } }));
  return { type: 'text', text: '了解！その2駅やと、いくつか路線があるみたいやな。どれを一番よく使う？', quickReply: { items: items.slice(0, 13) } };
};
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
cron.schedule('0 8 * * *', async () => { /* ... */ });
cron.schedule('* * * * *', () => { /* ... */ });


// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分【リセット修正版】
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }
  const userId = event.source.userId;
  const userText = event.message.text.trim();

  // ★★★ どんな状況でも「リセット」を最優先でチェックする ★★★
  if (userText === 'リセット') {
    delete userDatabase[userId];
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。もう一度話しかけて、最初から設定し直してな。' });
  }

  // 新規ユーザーか、リセット直後のユーザーかをチェック
  if (event.type === 'follow' || !userDatabase[userId]) {
    userDatabase[userId] = {
      setupState: 'awaiting_location', prefecture: null, location: null,
      notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
      garbageDay: {}, reminders: [],
    };
    return client.replyMessage(event.replyToken, { type: 'text', text: '友達追加ありがとう！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n**県名でも市区町村名でも、どっちでもええよ。**\n（例：東京都 or 豊島区）\n\nもちろん、「東京都豊島区」みたいに、詳しい方が情報の精度は上がるけどね！' });
  }

  const user = userDatabase[userId];

  // 初期設定の会話フロー
  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location': { /* ... */ }
      case 'awaiting_time': { /* ... */ }
      case 'awaiting_route': { /* ... */ }
      case 'awaiting_line_selection': { /* ... */ }
      case 'awaiting_garbage': { /* ... */ }
    }
    // 注意：switch文の各caseは必ずreturnで終わるようにしてください
    return; // 設定中の場合は、ここで処理を終了
  }
  
  // ▼▼▼ 以下は設定完了後の通常会話 ▼▼▼

  if (userText.includes('ご飯') || userText.includes('ごはん')) { 
    return client.replyMessage(event.replyToken, getRecipe());
  }
  
  const reminderResult = chrono.ja.parse(userText);
  if (reminderResult.length > 0) {
    const reminderDate = reminderResult[0].start.date();
    const task = userText.replace(reminderResult[0].text, '').trim();
    if (task) {
      user.reminders.push({ date: reminderDate.toISOString(), task });
      return client.replyMessage(event.replyToken, { type: 'text', text: `あいよ！\n${reminderDate.toLocaleString('ja-JP')}に「${task}」やね。覚えとく！` });
    }
  }

  // どの機能にも当てはまらない場合は相槌
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
