// 必要な道具をインポートする
const express = require('express');
const { Client, middleware, SignatureValidationFailed, JSONParseError } = require('@line/bot-sdk');
const fs = require('fs/promises');
const path = require('path');

// --- 設定 ---
// Renderの環境変数から設定を読み込む
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.CHANNEL_SECRET || '',
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// --- 知識（都道府県の緯度経度） ---
const AREA_COORDINATES = {
  '北海道': { lat: 43.06, lon: 141.35 }, '青森': { lat: 40.82, lon: 140.74 }, '岩手': { lat: 39.7, lon: 141.15 },
  '宮城': { lat: 38.27, lon: 140.87 }, '秋田': { lat: 39.72, lon: 140.1 }, '山形': { lat: 38.25, lon: 140.33 },
  '福島': { lat: 37.75, lon: 140.47 }, '茨城': { lat: 36.34, lon: 140.45 }, '栃木': { lat: 36.57, lon: 139.88 },
  '群馬': { lat: 36.39, lon: 139.06 }, '埼玉': { lat: 35.86, lon: 139.65 }, '千葉': { lat: 35.61, lon: 140.12 },
  '東京': { lat: 35.69, lon: 139.69 }, '神奈川': { lat: 35.45, lon: 139.64 }, '新潟': { lat: 37.9, lon: 139.02 },
  '富山': { lat: 36.7, lon: 137.21 }, '石川': { lat: 36.59, lon: 136.63 }, '福井': { lat: 36.07, lon: 136.22 },
  '山梨': { lat: 35.66, lon: 138.57 }, '長野': { lat: 36.65, lon: 138.18 }, '岐阜': { lat: 35.39, lon: 136.72 },
  '静岡': { lat: 34.98, lon: 138.38 }, '愛知': { lat: 35.18, lon: 136.91 }, '三重': { lat: 34.73, lon: 136.51 },
  '滋賀': { lat: 35.0, lon: 135.87 }, '京都': { lat: 35.02, lon: 135.76 }, '大阪': { lat: 34.69, lon: 135.5 },
  '兵庫': { lat: 34.69, lon: 135.18 }, '奈良': { lat: 34.69, lon: 135.83 }, '和歌山': { lat: 34.23, lon: 135.17 },
  '鳥取': { lat: 35.5, lon: 134.24 }, '島根': { lat: 35.47, lon: 133.05 }, '岡山': { lat: 34.66, lon: 133.92 },
  '広島': { lat: 34.39, lon: 132.46 }, '山口': { lat: 34.19, lon: 131.47 }, '徳島': { lat: 34.07, lon: 134.56 },
  '香川': { lat: 34.34, lon: 134.04 }, '愛媛': { lat: 33.84, lon: 132.77 }, '高知': { lat: 33.56, lon: 133.53 },
  '福岡': { lat: 33.59, lon: 130.4 }, '佐賀': { lat: 33.25, lon: 130.3 }, '長崎': { lat: 32.75, lon: 129.87 },
  '熊本': { lat: 32.79, lon: 130.7 }, '大分': { lat: 33.24, lon: 131.61 }, '宮崎': { lat: 31.91, lon: 131.42 },
  '鹿児島': { lat: 31.56, lon: 130.56 }, '沖縄': { lat: 26.21, lon: 127.68 }
};

// LINEと通信するためのクライアント
const client = new Client(config);
// Webサーバーの準備
const app = express();

// --- データベース関連の関数 ---
// データベース(JSONファイル)を読み込む
async function readDB() {  
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // ファイルがない場合は空のデータで初期化
    if (error.code === 'ENOENT') {
      await fs.writeFile(DB_PATH, JSON.stringify({ users: {}, disaster: {} }), 'utf8');
      return { users: {}, disaster: {} };
    }
    console.error("データベースの読み込みに失敗:", error);
    return { users: {}, disaster: {} };
  }
}

// データベースに書き込む
async function writeDB(data) {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error("データベースの書き込みに失敗:", error);
  }
}

// ユーザー情報を取得する
async function getUserState(userId) {
  const db = await readDB();
  const defaultState = {
    profile: {
      reminders: [],
      garbageInfo: [],
      disasterReminderEnabled: true,
      disasterAlertEnabled: true,
      prefecture: null,
      route: {},
      notificationTime: null,
      offDays: []
    },
    context: {}
  };

  const userState = db.users[userId] || defaultState;
  // データ構造が古い場合に備えて、デフォルトとマージする
  userState.profile = { ...defaultState.profile, ...(userState.profile || {}) };
  userState.context = userState.context || {};
  
  return userState;
}

// ユーザー情報を保存する
async function saveUserState(userId, profile, context = {}) {
  const db = await readDB();
  db.users[userId] = { profile, context };
  await writeDB(db);
}

// --- LINE Webhookのメイン処理 ---
// LINEからの通信は、必ず/webhookという住所に来るようにする
app.post('/webhook', middleware(config), (req, res) => {
  // LINEからの通信が正当なものか、自動で検証してくれる

  // Webhookの検証リクエストの場合は、ここで処理を終了
  if (req.body.events.length === 0) {
    return res.json({});
  }

  // 送られてきたイベントを一つずつ処理する
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- イベント処理の司令塔 ---
async function handleEvent(event) {
  // フォローイベントとメッセージイベント以外は無視
  if (event.type !== 'message' && event.type !== 'follow') {
    return null;
  }
  
  // テキストメッセージ以外は無視
  if (event.type === 'message' && event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const replyToken = event.replyToken;

  if (event.type === 'follow') {
    const welcomeMessage = `友達追加おおきに！わしが、あんた専属の「おかんAI」やで！\n\nあんたの事を色々教えてほしいんやけど、ええか？\nまずは、毎朝の通知のために、あんたが住んでる都道府県を教えてな。`;
    const initialState = await getUserState(userId); // デフォルトプロファイルを取得
    await saveUserState(userId, initialState.profile, { type: 'initial_registration', step: 'ask_prefecture' });
    return client.replyMessage(replyToken, { type: 'text', text: welcomeMessage });
  }

  if (event.type === 'message') {
    const userMessage = event.message.text;
    const { profile, context } = await getUserState(userId);

    // ここから下のロジックはGAS版とほぼ同じ
    // (非同期処理に対応するため、async/awaitを追加)
    // ... (GAS版のhandleMessageEventのロジックをここに移植) ...
    // 例：
    if (userMessage === '設定') {
      return handleSettingsRequest(replyToken);
    }
    // ...など、全ての会話ロジックをここに追加していく
    
    // 仮の応答
    return client.replyMessage(replyToken, { type: 'text', text: `「${userMessage}」て言うたな！(開発中)` });
  }
}

// --- 設定メニューの関数 ---
function handleSettingsRequest(replyToken) {
  const text = "どうする？ わしにできる事の一覧も確認できるで。";
  const quickReply = {
    items: [
      { type: "action", action: { type: "message", label: "できることを確認", text: "できることを確認" }},
      { type: "action", action: { type: "message", label: "ゴミの日を設定する", text: "ゴミの日を設定する" }},
      { type: "action", action: { type: "message", label: "通知時間を変更する", text: "通知時間を変更する" }},
      { type: "action", action: { type: "message", label: "防災通知を設定する", text: "防災通知を設定する" }},
    ]
  };
  return client.replyMessage(replyToken, { type: 'text', text, quickReply });
}


// Webサーバーを起動
app.listen(PORT, () => {
  console.log(`おかんAIがポート${PORT}で起動したで！`);
});

// (注意) このファイルには、まだおかんAIの全ての会話ロジック(リマインダー、ご飯提案など)は移植されていません。
// まずはこの基本構造でLINEとの通信を成功させることが目的です。
