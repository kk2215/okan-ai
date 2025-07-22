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

// 6. LINEからのメッセージを処理するメインの部分【駅登録バグ修正版】
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) { return null; }
  const userId = event.source.userId;
  const userText = event.message.text.trim();

  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
  }
  let user = await getUser(userId);
  if (!user) {
    user = await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n県名でも市区町村名でも、どっちでもええよ。（例：東京都 or 豊島区）'});
  }

  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location':
        const geoData = await getGeoInfo(userText);
        if (!geoData) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その地域は見つけられへんかったわ。もう一度教えてくれる？' }); }
        user.location = geoData.name; user.prefecture = geoData.prefecture;
        user.setupState = 'awaiting_time';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      case 'awaiting_time':
        user.notificationTime = userText;
        user.setupState = 'awaiting_route';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する経路を「〇〇駅から〇〇駅」のように教えてくれる？` });
      case 'awaiting_route': {
        const match = userText.match(/(.+?)駅?から(.+?)駅?/);
        if (!match) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、うまく聞き取れへんかった。「〇〇駅から〇〇駅」の形で教えてくれる？' }); }
        const [ , departureName, arrivalName ] = match;
        const departureStations = await findStation(departureName.trim());
        const arrivalStations = await findStation(arrivalName.trim());
        if (departureStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${departureName}」という駅が見つからへんかったわ。` }); }
        if (arrivalStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${arrivalName}」という駅が見つからへんかったわ。` }); }
        const departure = departureStations.find(s => s.prefecture === user.prefecture) || departureStations[0];
        const arrival = arrivalStations.find(s => s.prefecture === user.prefecture) || arrivalStations[0];
        user.departureStation = departure; user.arrivalStation = arrival;

        // ★★★ ここが重大なバグ修正箇所 ★★★
        // APIから返される路線は配列ではなく、スペース区切りの文字列なので、配列に変換する
        const departureLines = departure.line ? departure.line.split(' ') : [];
        const arrivalLines = arrival.line ? arrival.line.split(' ') : [];
        const commonLines = departureLines.filter(line => arrivalLines.includes(line));

        if (commonLines.length === 0) {
          user.setupState = 'awaiting_garbage';
          await updateUser(userId, user);
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${departure.name}駅」と「${arrival.name}駅」は覚えたで。ただ、2駅を直接結ぶ路線は見つからへんかったわ…。\n\n最後に、ゴミの日を教えてくれる？` });
        } else if (commonLines.length === 1) {
          user.trainLine = commonLines[0];
          user.setupState = 'awaiting_garbage';
          await updateUser(userId, user);
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${departure.name}駅」から「${arrival.name}駅」まで、「${user.trainLine}」を使うんやね。覚えたで！\n\n最後に、ゴミの日を教えてくれる？` });
        } else {
          user.setupState = 'awaiting_line_selection';
          await updateUser(userId, user);
          return client.replyMessage(event.replyToken, createLineSelectionReply(commonLines));
        }
      }
      case 'awaiting_line_selection':
        user.trainLine = userText;
        user.setupState = 'awaiting_garbage';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${user.trainLine}」やね、覚えたで！\n\n最後に、ゴミの日を教えてくれる？\n（例：「可燃ゴミは月曜日」と一つずつ教えてな。終わったら「おわり」と入力してや）` });
      case 'awaiting_garbage':
        // ... (このケースは変更なし) ...
    }
    return;
  }
  
  // ... (通常会話の処理は変更なし) ...
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