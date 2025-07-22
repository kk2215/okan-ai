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


// 6. LINEからのメッセージを処理するメインの部分【リセット動作修正版】
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }
  const userId = event.source.userId;
  const userText = event.message.text.trim();

  // 「リセット」という言葉を受け取ったら、まずユーザーデータを削除する
  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
  }

  // ユーザーデータを取得する
  let user = await getUser(userId);

  // ユーザーが存在しない場合（新規、またはリセット直後）、初期設定を開始する
  if (!user) {
    user = await createUser(userId); // 新しい設定データを作成
    // すぐに最初の質問を送信する
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n**県名でも市区町村名でも、どっちでもええよ。**\n（例：東京都 or 豊島区）'
    });
  }

  // ---- これより下は、既存の処理（変更なし）----

  // 初期設定の会話フロー
  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location': {
        const geoData = await getGeoInfo(userText);
        if (!geoData) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その地域は見つけられへんかったわ。もう一度、正しい名前で教えてくれる？' }); }
        user.location = geoData.name;
        user.prefecture = geoData.prefecture;
        user.setupState = 'awaiting_time';
        await updateUser(userId, user); // ★DBに保存
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      }
      case 'awaiting_time': {
        user.notificationTime = userText;
        user.setupState = 'awaiting_route';
        await updateUser(userId, user); // ★DBに保存
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する経路を「〇〇駅から〇〇駅」のように教えてくれる？` });
      }
      // ... 他のcase文も同様に、最後に updateUser(userId, user) を入れる ...
    }
    return;
  }
  
  // 設定完了後の通常会話
  if (userText.includes('ご飯') || userText.includes('ごはん')) { 
    return client.replyMessage(event.replyToken, getRecipe());
  }
  // ...リマインダーなどの処理...

  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
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
