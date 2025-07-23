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
const fs = require('fs');
const Fuse = require('fuse.js');
const cheerio = require('cheerio');

// ----------------------------------------------------------------
// 2. 設定
// ----------------------------------------------------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let cityList = [];
let fuse;
try {
  cityList = JSON.parse(fs.readFileSync('city-list.json', 'utf8'));
  fuse = new Fuse(cityList, { keys: ['city', 'prefecture'], threshold: 0.3 });
  console.log('辞書ファイル(city-list.json)の読み込みに成功しました。');
} catch (error) {
  console.error('★★★★ 致命的エラー: city-list.jsonの読み込みに失敗しました。ファイルが存在するか、JSONの形式が正しいか確認してください。 ★★★★');
}

// ----------------------------------------------------------------
// 3. データベース関数
// ----------------------------------------------------------------
const getUser = async (userId) => {
  try {
    const res = await pool.query('SELECT data FROM users WHERE user_id = $1', [userId]);
    return res.rows[0] ? res.rows[0].data : null;
  } catch (error) { console.error('DB Error on getUser:', error); return null; }
};
const createUser = async (userId) => {
  const newUser = {
    setupState: 'awaiting_location', prefecture: null, location: null, cityId: null,
    notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
    garbageDay: {}, reminders: [],
  };
  await pool.query('INSERT INTO users (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = $2', [userId, newUser]);
  return newUser;
};
const updateUser = async (userId, userData) => {
  await pool.query('UPDATE users SET data = $1 WHERE user_id = $2', [userData, userId]);
};

// ----------------------------------------------------------------
// 4. 各機能の部品 (ヘルパー関数)
// ----------------------------------------------------------------
const findCityId = (locationName) => {
  if (!fuse) { console.error('Fuse.jsが初期化されていないため、都市検索を実行できません。'); return null; }
  const searchTerm = locationName.replace(/[市市区町村]$/, '');
  const results = fuse.search(searchTerm);
  if (results.length > 0) {
    const item = results[0].item;
    return { name: `${item.prefecture} ${item.city}`, id: item.id, prefecture: item.prefecture };
  }
  return null;
};
const getWeather = async (cityId) => {
  if (!cityId) return 'ごめん、天気を調べるための都市IDが見つけられへんかったわ。';
  try {
    const url = `https://weather.tsukumijima.net/api/forecast/city/${cityId}`;
    const response = await axios.get(url);
    const weather = response.data;
    const todayForecast = weather.forecasts[0];
    const location = weather.location.city;
    const description = todayForecast.telop;
    const maxTemp = todayForecast.temperature.max?.celsius || '--';
    const minTemp = todayForecast.temperature.min?.celsius || '--';
    let message = `今日の${location}の天気は「${description}」やで。\n最高気温は${maxTemp}度、最低気温は${minTemp}度くらいになりそうや。`;
    if (description.includes('雨')) { message += '\n雨が降るかもしれんから、傘持って行った方がええよ！☔'; }
    return message;
  } catch (error) { console.error("Tsukumijima Weather APIでエラー:", error); return 'ごめん、天気予報の取得に失敗してもうた…'; }
};
const findStation = async (stationName) => { /* ... */ };
const createLineSelectionReply = (lines) => { /* ... */ };
const getRecipe = () => { /* ... */ };
const getTrainStatus = async (trainLineName) => { /* ... */ };

// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
cron.schedule('0 8 * * *', async () => { /* ... */ }, { timezone: "Asia/Tokyo" });
cron.schedule('* * * * *', async () => { /* ... */ }, { timezone: "Asia/Tokyo" });

// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type !== 'message' || event.message.type !== 'text') { return null; }
  const userId = event.source.userId;
  const userText = event.message.text.trim();

  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットして、新しく始めるで！\n「天気予報」に使う市区町村の名前を教えてな。（例：札幌、横浜）'});
  }

  let user = await getUser(userId);
  if (!user) {
    user = await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '初めまして！設定を始めるで！\n「天気予報」に使う市区町村の名前を教えてな。（例：札幌、横浜）'});
  }

  if (user.setupState && user.setupState !== 'complete') {
    // ... (設定フローのswitch文は、前回の完全版と同じです) ...
    return;
  }
  
  // ▼▼▼ 設定完了後のユーザーの会話は、ここから処理されます ▼▼▼

  // リマインダー機能
  if (userText.includes('リマインド') || userText.includes('思い出させて')) {
    let reminderDate = null;
    let task = '';
    const nowInJapan = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const relativeMatch = userText.match(/(\d+)\s*(分|時間)後/);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];
      let targetDate = new Date(nowInJapan);
      if (unit === '分') { targetDate.setMinutes(targetDate.getMinutes() + amount); }
      else if (unit === '時間') { targetDate.setHours(targetDate.getHours() + amount); }
      reminderDate = targetDate;
      task = userText.replace(relativeMatch[0], '').replace(/ってリマインドして?/, '').replace(/と思い出させて?/, '').trim();
    } else {
      const reminderResult = chrono.ja.parse(userText, nowInJapan);
      if (reminderResult.length > 0) {
        reminderDate = reminderResult[0].start.date();
        task = userText.replace(reminderResult[0].text, '').replace(/ってリマインドして?/, '').replace(/と思い出させて?/, '').trim();
      }
    }
    if (reminderDate && task) {
      user.reminders.push({ date: reminderDate.toISOString(), task });
      await updateUser(userId, user);
      return client.replyMessage(event.replyToken, { type: 'text', text: `あいよ！\n${reminderDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}に「${task}」やね。覚えとく！` });
    }
  }

  // 献立提案機能
  if (userText.includes('ご飯') || userText.includes('ごはん')) {
    return client.replyMessage(event.replyToken, getRecipe());
  }

  // どの機能にも当てはまらない場合の相槌
  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
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
    .catch(err => {
      console.error("▼▼▼ 致命的なエラーが発生しました ▼▼▼");
      if (err instanceof Error) {
        console.error("エラー名:", err.name);
        console.error("メッセージ:", err.message);
        console.error("スタックトレース:", err.stack);
      } else { console.error("エラー内容:", err); }
      console.error("▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲");
      if (req.body.events && req.body.events[0] && req.body.events[0].replyToken) {
        client.replyMessage(req.body.events[0].replyToken, { type: 'text', text: 'ごめん、ちょっと調子が悪いみたい…。もう一度試してくれるかな？' });
      }
      res.status(500).end();
    });
});

app.listen(PORT, async () => {
  await setupDatabase();
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});