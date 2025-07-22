// ----------------------------------------------------------------
// 1. ライブラリの読み込み
// ----------------------------------------------------------------
require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const chrono = require('chrono-node');
const { Pool } = require('pg');

// ----------------------------------------------------------------
// 2. 設定
// ----------------------------------------------------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OPEN_WEATHER_API_KEY = process.env.OPEN_WEATHER_API_KEY;
const client = new Client(config);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ----------------------------------------------------------------
// 3. データベース関数
// ----------------------------------------------------------------
const getUser = async (userId) => {
  try {
    const res = await pool.query('SELECT data FROM users WHERE user_id = $1', [userId]);
    return res.rows[0] ? res.rows[0].data : null;
  } catch (error) {
    console.error('DB Error on getUser:', error);
    return null;
  }
};
const createUser = async (userId) => {
  const newUser = {
    setupState: 'awaiting_location', prefecture: null, location: null,
    notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
    garbageDay: {}, reminders: [],
  };
  await pool.query('INSERT INTO users (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = $2', [userId, newUser]);
  return newUser;
};
const updateUser = async (userId, userData) => {
  await pool.query('UPDATE users SET data = $1 WHERE user_id = $2', [userData, userId]);
};

// 4. 各機能の部品 (ヘルパー関数)

/** 住所情報をAPIで検索・検証する関数【undefined修正版】 */
const getGeoInfo = async (locationName) => {
  try {
    let geoResponse = await axios.get('https://geoapi.heartrails.com/api/json', { params: { method: 'getTowns', city: locationName } });
    if (geoResponse.data.response.location) {
      const loc = geoResponse.data.response.location[0];
      return { name: `${loc.prefecture}${loc.city}`, prefecture: loc.prefecture };
    }
    const stations = await findStation(locationName);
    if (stations.length > 0) {
      const bestMatch = stations[0];
      const prefecture = bestMatch.prefecture;
      const city = bestMatch.city; // 市の名前がAPIから返されない場合がある
      const fullName = city ? `${prefecture}${city}` : prefecture; // 市がなければ県名だけを返す
      return { name: fullName, prefecture: prefecture };
    }
    return null;
  } catch (error) {
    console.error("getGeoInfoでエラー:", error);
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
  const items = lines.map(line => ({ type: 'action', action: { type: 'message', label: line, text: line } }));
  return { type: 'text', text: '了解！その2駅やと、いくつか路線があるみたいやな。どれを一番よく使う？', quickReply: { items: items.slice(0, 13) } };
};

/** 献立を提案する関数 */
const getRecipe = () => { /* ... */ };

/** 天気情報を取得する関数 */
const getWeather = async (location) => { /* ... */ };

// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
cron.schedule('0 8 * * *', async () => { /* ... */ });
cron.schedule('* * * * *', () => { /* ... */ });

// 6. LINEからのメッセージを処理するメインの部分【根本バグ修正版】
const handleEvent = async (event) => {
  const userId = event.source.userId;
  
  // イベントが「友だち追加」の場合の処理
  if (event.type === 'follow') {
    let user = await getUser(userId);
    if (!user) {
      user = await createUser(userId);
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n県名でも市区町村名でも、どっちでもええよ。（例：東京都 or 豊島区）'
    });
  }

  // イベントが「メッセージ」ではない、または「テキストメッセージ」ではない場合は、ここで処理を終了
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }
  
  // これ以降は、イベントがテキストメッセージであることが確定している
  const userText = event.message.text.trim();

  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    // リセット後は、次のメッセージで下の!userブロックに入る
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。何か話しかけてな。' });
  }

  let user = await getUser(userId);
  if (!user) {
    user = await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n県名でも市区町村名でも、どっちでもええよ。（例：東京都 or 豊島区）'});
  }

  // ... (以降のswitch文や通常会話の処理は、以前のコードと同じです) ...
  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
        // ... 各case ...
    }
  }
};

// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const setupDatabase = async () => { /* ... */ };
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Okan AI is running!'));
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error("Request Handling Error: ", err); res.status(500).end(); });
});
app.listen(PORT, async () => {
  await setupDatabase();
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});