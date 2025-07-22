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
const xml2js = require('xml2js'); 

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

/** 住所情報をOpenWeatherMap APIで検索・検証する関数【最終版】 */
const getGeoInfo = async (locationName) => {
  try {
    const response = await axios.get('http://api.openweathermap.org/geo/1.0/direct', {
      params: {
        q: `${locationName},JP`, // 日本国内に限定して検索
        limit: 1,
        appid: OPEN_WEATHER_API_KEY,
      }
    });

    if (response.data.length === 0) {
      return null; // 場所が見つからなかった
    }

    const result = response.data[0];
    const prefecture = result.state || '';
    const city = result.local_names ? result.local_names.ja || result.name : result.name;

    // 県名と市名が同じ場合（例: 千葉、千葉市）は県名だけを返すなど、整形
    const fullName = prefecture === city ? prefecture : `${prefecture}${city}`;

    return { name: fullName, prefecture: prefecture };
  } catch (error) {
    console.error("OpenWeatherMap Geocoding APIでエラー:", error);
    return null;
  }
};

// ... (findStation, createLineSelectionReplyなどの他の関数は変更なし) ...

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

/** 気象庁の警報・注意報をチェックする関数 */
let sentAlertsCache = {}; // 配信済みアラートを一時的に記憶する場所
const checkWeatherAlerts = async () => {
  try {
    console.log('気象庁の防災情報をチェックします...');
    // 気象警報・注意報のフィードを取得
    const feedUrl = 'https://www.data.jma.go.jp/developer/xml/feed/regular_l.xml';
    const response = await axios.get(feedUrl);
    
    // XMLをJavaScriptオブジェクトに変換
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    const latestAlerts = result.feed.entry;
    if (!latestAlerts) return;

    for (const alert of latestAlerts) {
      const alertId = alert.id[0];
      const title = alert.title[0];
      const areaName = alert.author[0].name[0]; // 発表された地域名

      // 「警報」または「注意報」で、まだ配信していない新しいアラートかチェック
      if (title.includes('気象警報・注意報') && !sentAlertsCache[alertId]) {
        // 登録されている全ユーザーをチェック
        for (const userId in userDatabase) {
          const user = await getUser(userId);
          // ユーザーの登録地域がアラートの対象地域に含まれているかチェック
          if (user && user.location && areaName.includes(user.prefecture)) {
            const message = `【気象庁情報】\n${areaName}に${title}が発表されたで。気をつけてな！`;
            client.pushMessage(userId, { type: 'text', text: message });
            sentAlertsCache[alertId] = true; // 配信済みとして記憶
          }
        }
      }
    }
    // 古いキャッシュを削除（メモリリーク対策）
    const cacheKeys = Object.keys(sentAlertsCache);
    if (cacheKeys.length > 100) {
      delete sentAlertsCache[cacheKeys[0]];
    }
  } catch (error) {
    console.error('防災情報のチェック中にエラー:', error);
  }
};

// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
cron.schedule('0 8 * * *', async () => { /* ... */ });
cron.schedule('* * * * *', () => { /* ... */ });
cron.schedule('*/10 * * * *', checkWeatherAlerts, {
  timezone: "Asia/Tokyo"
});

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
      text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を、**必ず「〇〇市」や「〇〇区」のように、末尾まで正確に**教えてくれる？\n\n（例：埼玉県春日部市、東京都豊島区）\n\nこの方が、AIが場所を間違えずに済むんや。協力おおきに！'
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

// 7. サーバーを起動
const setupDatabase = async () => { /* ... */ };
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Okan AI is running!'));

// ▼▼▼ この app.post の部分を丸ごと置き換え ▼▼▼
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      // ★★★ ここからがエラー処理の強化部分 ★★★
      console.error("リクエスト処理中に致命的なエラー:", err);
      // エラーが発生したイベントの最初のものに対して、エラーメッセージを返信しようと試みる
      if (req.body.events && req.body.events[0] && req.body.events[0].replyToken) {
        client.replyMessage(req.body.events[0].replyToken, {
          type: 'text',
          text: 'ごめん、ちょっと調子が悪いみたい…。もう一度試してくれるかな？'
        }).catch(replyErr => {
          console.error("エラーメッセージの返信にも失敗:", replyErr);
        });
      }
      res.status(500).end();
      // ★★★ ここまで ★★★
    });
});

app.listen(PORT, async () => {
  await setupDatabase();
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});