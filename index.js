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
    // まず市区町村として検索
    let response = await axios.get('https://geoapi.heartrails.com/api/json', {
      params: { method: 'getTowns', city: locationName }
    });
    if (response.data.response.location) {
      const loc = response.data.response.location[0];
      return { name: `${loc.prefecture}${loc.city}`, prefecture: loc.prefecture };
    }
    // ダメなら都道府県として検索
    response = await axios.get('https://geoapi.heartrails.com/api/json', {
      params: { method: 'getPrefectures' }
    });
    const prefectures = response.data.response.prefecture;
    const foundPref = prefectures.find(p => p === locationName || p.replace(/[県府都]$/, '') === locationName);
    if (foundPref) {
      return { name: foundPref, prefecture: foundPref };
    }
    return null;
  } catch (error) {
    console.error("地理情報APIエラー:", error);
    return null;
  }
};

/** 駅情報をAPIで検索・検証する関数 */
const findStation = async (stationName) => { /* ... 以前のコードと同じ ... */ };

/** 路線選択のためのQuick Replyメッセージを作成する関数 */
const createLineSelectionReply = (lines) => { /* ... 以前のコードと同じ ... */ };

const getRecipe = () => { /* ... 以前のコードと同じ ... */ };

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
  for (const userId in userDatabase) {
    if (Object.hasOwnProperty.call(userDatabase, userId) && userDatabase[userId].setupState === 'complete') {
        const user = userDatabase[userId];
        let morningMessage = 'おはよー！朝やで！\n';
        // 毎朝の天気を必ず通知
        const weatherInfo = await getWeather(user.location);
        morningMessage += `\n${weatherInfo}\n`;
        // ... 他の通知（ゴミの日、電車）は以前のコードと同じ ...
        client.pushMessage(userId, { type: 'text', text: morningMessage }).catch(err => console.error(err));
    }
  }
}, { timezone: "Asia/Tokyo" });

cron.schedule('* * * * *', () => { /* ... リマインダーチェック ... */ }, { timezone: "Asia/Tokyo" });

// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分【ログ増強版】
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  // この関数の先頭に追加
  console.log('[DEBUG] イベント受信:', JSON.stringify(event));

  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }

  const userId = event.source.userId;

  if (event.type === 'follow' || (event.type === 'message' && !userDatabase[userId])) {
    console.log('[DEBUG] 新規ユーザーまたはリセット後のため、初期設定を開始します。');
    userDatabase[userId] = {
      setupState: 'awaiting_location', prefecture: null, location: null,
      notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
      garbageDay: {}, reminders: [], temp: {}
    };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `友達追加ありがとう！\n「天気予報」と「防災情報」に使う地域を教えてな。\n\n**県名でも市区町村名でも、どっちでもええよ。**\n（例：東京都 or 豊島区）\n\nもちろん、「東京都豊島区」みたいに、詳しい方が情報の精度は上がるけどね！`
    });
  }

  const user = userDatabase[userId];
  const userText = event.message.text.trim();

  // 現在のステートをログに出力
  console.log(`[DEBUG] ユーザーID: ${userId}, 現在のステート: ${user.setupState}`);

  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location': {
        console.log('[DEBUG] >> "awaiting_location"の処理に入ります。');
        const geoData = await getGeoInfo(userText);
        if (!geoData) {
          console.error('[ERROR] 地理情報の取得に失敗しました。');
          return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その地域は見つけられへんかったわ。もう一度、正しい名前で教えてくれる？' });
        }
        user.location = geoData.name;
        user.prefecture = geoData.prefecture;
        user.setupState = 'awaiting_time';
        console.log(`[DEBUG] << "awaiting_location"の処理完了。ステートを"awaiting_time"に変更。`);
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？\n（例：朝8時、7:30）` });
      }

      case 'awaiting_time': {
        console.log('[DEBUG] >> "awaiting_time"の処理に入ります。');
        user.notificationTime = userText;
        user.setupState = 'awaiting_departure_station';
        console.log(`[DEBUG] << "awaiting_time"の処理完了。ステートを"awaiting_departure_station"に変更。`);
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する「乗る駅」だけを教えてくれる？` });
      }
      
      // ...以降のcase文も同様...
      
    }
  }

  // ...以降の通常会話の処理...
  console.log('[DEBUG] 通常会話の処理に入ります。');
  if (userText === 'リセット') { /* ... */ }
  // ...
  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
};

// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// RenderのヘルスチェックやUptimeRobot用のルート
app.get('/', (req, res) => res.send('Okan AI is running!'));

// LINEからの通信を受け取るための、一番重要なルート
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
