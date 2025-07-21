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

/** 駅情報をAPIで検索・検証する関数 */
const findStation = async (stationName) => {
  try {
    const response = await axios.get('http://express.heartrails.com/api/json', {
      params: { method: 'getStations', name: stationName }
    });
    return response.data.response.station || [];
  } catch (error) {
    console.error("駅情報APIエラー:", error);
    return [];
  }
};

/** 路線選択のためのQuick Replyメッセージを作成する関数 */
const createLineSelectionReply = (lines) => {
  const items = lines.map(line => ({
    type: 'action',
    action: { type: 'message', label: line, text: line }
  }));
  return {
    type: 'text',
    text: '了解！その2駅やと、いくつか路線があるみたいやな。どれを一番よく使う？',
    quickReply: { items: items.slice(0, 13) } // Quick Replyは最大13個まで
  };
};

// (getRecipe, getWeather関数は変更なし)
const getRecipe = () => { /* ... */ };
const getWeather = async (location) => { /* ... */ };

// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
// (スケジューラーのコードも変更ありません)
cron.schedule('0 8 * * *', async () => { /* ... */ }, { timezone: "Asia/Tokyo" });
cron.schedule('* * * * *', () => { /* ... */ }, { timezone: "Asia/Tokyo" });

// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分【大幅更新】
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) {
    return null;
  }

  const userId = event.source.userId;

  // 新規ユーザー or リセット直後
  if (event.type === 'follow' || !userDatabase[userId]) {
    userDatabase[userId] = {
      setupState: 'awaiting_location', prefecture: null, location: null,
      notificationTime: null, departureStation: null, arrivalStation: null, trainLine: null,
      garbageDay: {}, reminders: [], temp: {}
    };
    return client.replyMessage(event.replyToken, {
      type: 'text', text: '友達追加ありがとう！\nまず、天気予報で使う地域を「〇〇県〇〇市」のように教えてくれる？'
    });
  }

  const user = userDatabase[userId];
  const userText = event.message.text.trim();

  // 初期設定の会話フロー
  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      case 'awaiting_location': {
        try {
          // 住所APIで存在確認
          const geoResponse = await axios.get('https://geoapi.heartrails.com/api/json', { params: { method: 'getTowns', city: userText }});
          if (!geoResponse.data.response.location) {
            return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その地域は見つけられへんかったわ。もう一度、「〇〇県〇〇市」の形で教えてくれる？' });
          }
          const locationData = geoResponse.data.response.location[0];
          user.location = `${locationData.prefecture}${locationData.city}`;
          user.prefecture = locationData.prefecture;
          user.setupState = 'awaiting_time';
          return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？\n（例：朝8時、7:30）` });
        } catch (error) {
          return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、地域の確認でエラーが出てもうた。もう一度試してくれる？' });
        }
      }

      case 'awaiting_time': {
        user.notificationTime = userText;
        user.setupState = 'awaiting_departure_station';
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する「乗る駅」だけを教えてくれる？` });
      }

      case 'awaiting_departure_station': {
        const stations = await findStation(userText);
        const filteredStations = stations.filter(s => s.prefecture === user.prefecture);
        const targetStation = filteredStations.length > 0 ? filteredStations[0] : stations[0];

        if (!targetStation) {
          return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${userText}」という駅が見つからへんかった。もう一度、正しい駅名を教えてな。` });
        }
        user.departureStation = targetStation;
        user.setupState = 'awaiting_arrival_station';
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${targetStation.name}駅」やね。了解！\n次は、「降りる駅」だけを教えてな。` });
      }

      case 'awaiting_arrival_station': {
        const stations = await findStation(userText);
        const filteredStations = stations.filter(s => s.prefecture === user.prefecture);
        const targetStation = filteredStations.length > 0 ? filteredStations[0] : stations[0];

        if (!targetStation) {
          return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${userText}」という駅が見つからへんかった。もう一度、正しい駅名を教えてな。` });
        }
        user.arrivalStation = targetStation;

        // 乗る駅と降りる駅の路線リストから、共通の路線を探す
        const commonLines = user.departureStation.line.filter(line => user.arrivalStation.line.includes(line));

        if (commonLines.length === 0) {
          user.setupState = 'awaiting_garbage'; // 路線設定はスキップして次へ
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${targetStation.name}駅」やね。おおきに！\nただ、2駅を直接結ぶ路線が見つからへんかったわ…。\n\n気を取り直して、最後にゴミの日を教えてくれる？（なければ「なし」でOK）` });
        } else if (commonLines.length === 1) {
          user.trainLine = commonLines[0];
          user.setupState = 'awaiting_garbage';
          return client.replyMessage(event.replyToken, { type: 'text', text: `「${targetStation.name}駅」やね。2駅を結ぶのは「${user.trainLine}」やな！\n\n最後に、ゴミの日を教えてくれる？（なければ「なし」でOK）` });
        } else {
          user.setupState = 'awaiting_line_selection';
          return client.replyMessage(event.replyToken, createLineSelectionReply(commonLines));
        }
      }
      
      case 'awaiting_line_selection': {
        user.trainLine = userText;
        user.setupState = 'awaiting_garbage';
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${user.trainLine}」やね、覚えたで！\n\n最後に、ゴミの日を教えてくれる？\n（例：「可燃ゴミは月曜日」と一つずつ教えてな。終わったら「おわり」と入力してや）` });
      }

      case 'awaiting_garbage': {
        if (userText === 'おわり' || userText === 'なし') {
            user.setupState = 'complete';
            console.log(`ユーザーの初期設定が完了: ${userId}`);
            return client.replyMessage(event.replyToken, { type: 'text', text: '設定おおきに！これで全部や！\nこれからは毎朝通知するし、色々聞いてな！' });
        }
        const garbageMatch = userText.match(/(.+?ゴミ)は?(\S+?)曜日?/);
        if (garbageMatch) {
            const dayMap = { '日':0, '月':1, '火':2, '水':3, '木':4, '金':5, '土':6 };
            const garbageType = garbageMatch[1].trim();
            const dayOfWeek = garbageMatch[2];
            if (dayMap[dayOfWeek] !== undefined) {
              user.garbageDay[dayMap[dayOfWeek]] = garbageType;
              return client.replyMessage(event.replyToken, { type: 'text', text: `了解、「${garbageType}」が${dayOfWeek}曜日やね。他にもあったら教えてな。（終わったら「おわり」と入力）` });
            }
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、うまく聞き取れへんかったわ。「〇〇ゴミは△曜日」の形で教えてくれる？` });
      }
    }
  }
  
  // 通常会話（設定完了後）
  if (userText === 'リセット') {
      delete userDatabase[userId];
      return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。もう一度話しかけて、最初から設定し直してな。' });
  }

  // (既存の献立提案、リマインダー機能はここに続く)
  // ...
  
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
    .catch(err => { console.error(err); res.status(500).end(); });
});
app.listen(PORT, () => {
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});

// 既存のコードを貼り付ける部分の注意：
// 4.のgetRecipe, getWeather関数、5.のcron.schedule関数、
// 6.の献立提案やリマインダー部分を、このコードをベースにご自身のものと置き換えてください。
// このコードは、これらの関数が定義されていることを前提としています。