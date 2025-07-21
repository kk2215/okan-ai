// 必要な道具をインポートする
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const fs = require('fs/promises');
const path = require('path');
const fetch = require('node-fetch');

// --- 設定 ---
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

const client = new Client(config);
const app = express();

// --- データベース関数 ---
async function readDB() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const initialData = { users: {}, disaster: { lastEarthquakeId: "" } };
      await fs.writeFile(DB_PATH, JSON.stringify(initialData, null, 2), 'utf8');
      return initialData;
    }
    console.error("DB Read Error:", error);
    return { users: {}, disaster: { lastEarthquakeId: "" } };
  }
}

async function writeDB(data) {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error("DB Write Error:", error);
  }
}

async function getUserState(userId) {
  const db = await readDB();
  const defaultState = {
    profile: {
      reminders: [], garbageInfo: [], disasterReminderEnabled: true,
      disasterAlertEnabled: true, prefecture: null, route: {},
      notificationTime: null, offDays: []
    },
    context: {}
  };
  const userState = db.users[userId] || { ...defaultState };
  userState.profile = { ...defaultState.profile, ...(userState.profile || {}) };
  userState.context = userState.context || {};
  return userState;
}

async function saveUserState(userId, profile, context = {}) {
  const db = await readDB();
  db.users[userId] = { profile, context };
  await writeDB(db);
}

// --- LINE Webhook メイン処理 ---
app.post('/webhook', middleware(config), (req, res) => {
  if (!req.body || !Array.isArray(req.body.events)) {
    return res.status(200).json({});
  }
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Event handler error:", err);
      res.status(500).end();
    });
});

// --- イベント処理の司令塔 ---
async function handleEvent(event) {
  if (!event || !event.source || !event.source.userId) return null;
  if (event.type === 'follow') return handleFollowEvent(event.source.userId, event.replyToken);
  if (event.type === 'message' && event.message.type === 'text') {
    return handleMessageEvent(event.source.userId, event.message.text, event.replyToken);
  }
  return null;
}

// --- 各種イベントハンドラ ---
async function handleFollowEvent(userId, replyToken) {
  const welcomeMessage = `友達追加おおきに！わしが、あんた専属の「おかんAI」やで！\n\nあんたの事を色々教えてほしいんやけど、ええか？\nまずは、毎朝の通知のために、あんたが住んでる都道府県を教えてな。`;
  const { profile } = await getUserState(userId);
  await saveUserState(userId, profile, { type: 'initial_registration', step: 'ask_prefecture' });
  return client.replyMessage(replyToken, { type: 'text', text: welcomeMessage });
}

async function handleMessageEvent(userId, userMessage, replyToken) {
    const { profile, context } = await getUserState(userId);
    const command = userMessage.trim();

    if (context && context.type) {
        if (context.type === 'initial_registration') {
            return handleRegistrationConversation(userId, command, profile, context, replyToken);
        }
    }

    if (command === '設定') return handleSettingsRequest(replyToken);
    if (command === 'ヘルプ' || command === '何ができる？' || command === 'できることを確認') {
        return client.replyMessage(replyToken, { type: 'text', text: getHelpMessage() });
    }
    
    const statelessReplies = ['せやな！', 'ほんまそれ！', 'なるほどな〜', 'うんうん。', 'そうなんや！'];
    const randomReply = statelessReplies[Math.floor(Math.random() * statelessReplies.length)];
    return client.replyMessage(replyToken, { type: 'text', text: randomReply });
}

async function handleRegistrationConversation(userId, message, profile, context, replyToken) {
  let newProfile = { ...profile };
  let newContext = { ...context };

  switch (context.step) {
    case 'ask_prefecture':
      const prefecture = Object.keys(AREA_COORDINATES).find(pref => message.includes(pref));
      if (!prefecture) {
        return client.replyMessage(replyToken, { type: 'text', text: 'ごめんな、都道府県が分からんかったわ。もう一回、教えてくれるか？' });
      }
      newProfile.prefecture = prefecture;
      newContext.step = 'ask_stations';
      await saveUserState(userId, newProfile, newContext);
      return client.replyMessage(replyToken, { type: 'text', text: `「${prefecture}」やな、覚えたで！\n次は、いつも乗る駅と降りる駅を「新宿から渋谷」みたいに教えてな。\n電車を使わへんかったら「なし」って言うてくれてええで。` });
    
    default:
      await saveUserState(userId, profile, {});
      break;
  }
}

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

function getHelpMessage() {
  return `わしにできることは、こんな感じやで！

- - - - - - - - - - - - - - -
【毎日のお知らせ】
朝、設定してくれた時間に、天気とか電車の情報を教えるで！

【ご飯の提案】
「豚肉と玉ねぎで晩ごはん」みたいに食材を教えたり、単に「今日の晩ごはんは？」と聞くだけで、おすすめの献立を考えるで！

【リマインダー】
「明日の15時に会議って思い出して」で登録、「リマインダー一覧」で確認、「リマインダー 1番 削除」で消せるで。

【各種設定】
「設定」と話しかけると、下の項目をボタンで簡単に設定できるで！
・ゴミの日
・毎朝の通知時間
・防災通知のオン/オフ

【簡単な会話】
簡単な相槌やけど、話しかけてくれたら返事するで！
- - - - - - - - - - - - - - -

困ったら「ヘルプ」か「何ができる？」って聞いてな！`;
}

app.listen(PORT, () => {
  console.log(`おかんAIがポート${PORT}で起動したで！`);
});
