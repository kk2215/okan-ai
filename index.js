// 1. ライブラリの読み込み
require('dotenv').config();
const express = require('express');
const { Client } = require('@line/bot-sdk'); // middlewareは後で使うので一旦削除
const axios = require('axios');
const cron = require('node-cron');
const chrono = require('chrono-node');
const { Pool } = require('pg'); // ★ この行を追加

// 2. 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OPEN_WEATHER_API_KEY = process.env.OPEN_WEATHER_API_KEY;
const client = new Client(config);

// ★ ここから下を丸ごと追加 ★
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
// ★ ここまで追加 ★

// 3. データベース関数
const getUser = async (userId) => {
  const res = await pool.query('SELECT data FROM users WHERE user_id = $1', [userId]);
  return res.rows[0] ? res.rows[0].data : null;
};

const createUser = async (userId) => {
  const newUser = {
    setupState: 'awaiting_location', prefecture: null, location: null,
    notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
    garbageDay: {}, reminders: [],
  };
  await pool.query('INSERT INTO users (user_id, data) VALUES ($1, $2)', [userId, newUser]);
  return newUser;
};

const updateUser = async (userId, userData) => {
  await pool.query('UPDATE users SET data = $1 WHERE user_id = $2', [userData, userId]);
};

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


// 6. LINEからのメッセージを処理するメインの部分
const lineMiddleware = require('@line/bot-sdk').middleware; // middlewareをここで定義

const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }
  const userId = event.source.userId;
  const userText = event.message.text.trim();

  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。' });
  }

  let user = await getUser(userId);

  if (event.type === 'follow' || !user) {
    user = await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '友達追加ありがとう！...' }); // 挨拶文は省略
  }
  
  // 初期設定の会話フロー
  if (user.setupState && user.setupState !== 'complete') {
    // switch文の中のロジックはほぼ同じですが、
    // 各caseの最後で updateUser(userId, user) を呼び出すように変更します。
    // 例：
    // case 'awaiting_location': {
    //   ...
    //   await updateUser(userId, user); // ★ 状態を更新したらDBに保存
    //   return client.replyMessage(...);
    // }
  }

  // ... 通常会話の処理でも、userオブジェクトを変更したら updateUser(userId, user) で保存 ...
};


// 7. サーバーを起動
const setupDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id VARCHAR(255) PRIMARY KEY,
      data JSONB
    );
  `);
  console.log('データベースのテーブル準備OK！');
};

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Okan AI is running!'));
app.post('/webhook', lineMiddleware(config), (req, res) => { // ここをlineMiddlewareに変更
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error(err); res.status(500).end(); });
});

app.listen(PORT, async () => {
  await setupDatabase(); // ★ サーバー起動時にDBセットアップを実行
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});