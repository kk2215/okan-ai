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
const fs = require('fs'); // ★ ファイル読み込み用
const Fuse = require('fuse.js'); // ★ あいまい検索用

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

// AI起動時に、辞書ファイル(city-list.json)を読み込む
const cityList = JSON.parse(fs.readFileSync('city-list.json', 'utf8'));
// あいまい検索の準備【最終決定版】
const fuse = new Fuse(cityList, {
  keys: ['city', 'prefecture'], // ★「市」と「県」の両方の項目を検索対象にする
  threshold: 0.3,
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
/** [最終決定版] あいまい検索で都市IDを見つける関数 */
const findCityId = (locationName) => {
  // ユーザー入力から「市」「区」「町」「村」などを一旦取り除く
  const searchTerm = locationName.replace(/[市市区町村]$/, '');
  const results = fuse.search(searchTerm);
  
  if (results.length > 0) {
    const item = results[0].item;
    // 辞書から見つかった正式名称とIDを返す
    return { name: `${item.prefecture} ${item.city}`, id: item.id, prefecture: item.prefecture };
  }
  return null; // 見つからなかった場合
};
// ... (他のヘルパー関数) ...
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

// 6. LINEからのメッセージを処理するメインの部分【地名聞き返し機能つき】
const handleEvent = async (event) => {
  if (event.type !== 'follow' && (event.type !== 'message' || event.message.type !== 'text')) { return null; }
  const userId = event.source.userId;

  // 友だち追加イベントの場合は、ユーザーデータを作成して挨拶を返す
  if (event.type === 'follow') {
    let user = await getUser(userId);
    if (!user) { user = await createUser(userId); }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を、必ず「〇〇市」や「〇〇区」のように、末尾まで正確に教えてくれる？\n\n（例：埼玉県春日部市、東京都豊島区）'
    });
  }

  // これ以降はメッセージイベントの処理
  const userText = event.message.text.trim();

  if (userText === 'リセット') {
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    // リセット後は、次のメッセージで下の!userブロックに入る
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定をリセットしたで。何か話しかけてな。' });
  }

  let user = await getUser(userId);
  if (!user) {
    user = await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '設定を始めるで！\n「天気予報」と「防災情報」に使う地域を、必ず「〇〇市」や「〇〇区」のように、末尾まで正確に教えてくれる？\n\n（例：埼玉県春日部市、東京都豊島区）'});
  }

  if (user.setupState && user.setupState !== 'complete') {
    switch (user.setupState) {
      // ...
      case 'awaiting_location': {
        const cityInfo = findCityId(userText); // 新しい辞書検索を実行
        if (!cityInfo) {
          return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その都市の天気予報IDが見つけられへんかったわ。日本の市区町村名で試してくれるかな？' });
        }
        user.location = cityInfo.name;      // 「埼玉県 熊谷」のような正式名称
        user.cityId = cityInfo.id;          // 天気予報で使う都市ID
        user.prefecture = cityInfo.prefecture; // 県名も正しく更新
        user.setupState = 'awaiting_time';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      }
        user.temp = { location_candidates: locations };
        user.setupState = 'awaiting_prefecture_clarification';
        await updateUser(userId, user);
        const prefectures = [...new Set(locations.map(loc => loc.state).filter(Boolean))];
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `「${userText}」やね。いくつか候補があるみたいやけど、どの都道府県のこと？`,
          quickReply: { items: prefectures.map(p => ({ type: 'action', action: { type: 'message', label: p, text: p } })) }
        });
      }
      case 'awaiting_prefecture_clarification'; {
        const candidates = user.temp.location_candidates || [];
        const chosen = candidates.find(loc => loc.state === userText);
        if (!chosen) {
          return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、下のボタンから選んでくれるかな？' });
        }
        const prefecture = chosen.state || '';
        const city = chosen.local_names ? chosen.local_names.ja || chosen.name : chosen.name;
        user.location = prefecture === city ? prefecture : `${prefecture}${city}`;
        user.prefecture = prefecture;
        user.setupState = 'awaiting_time';
        delete user.temp;
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      }
      case 'awaiting_time'; {
        user.notificationTime = userText;
        user.setupState = 'awaiting_route';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する経路を「〇〇駅から〇〇駅」のように教えてくれる？` });
      }
      case 'awaiting_route'; {
        const match = userText.match(/(.+?)駅?から(.+)駅?$/);
        if (!match) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、うまく聞き取れへんかった。「〇〇駅から〇〇駅」の形でもう一度教えてくれる？' }); }
        const [ , departureName, arrivalName ] = match;
        const departureStations = await findStation(departureName.trim());
        const arrivalStations = await findStation(arrivalName.trim());
        if (departureStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${departureName}」という駅が見つからへんかったわ。` }); }
        if (arrivalStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${arrivalName}」という駅が見つからへんかったわ。` }); }
        const departure = departureStations.find(s => s.prefecture === user.prefecture) || departureStations[0];
        const arrival = arrivalStations.find(s => s.prefecture === user.prefecture) || arrivalStations[0];
        user.departureStation = departure; user.arrivalStation = arrival;
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
      case 'awaiting_line_selection'; {
        user.trainLine = userText;
        user.setupState = 'awaiting_garbage';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${user.trainLine}」やね、覚えたで！\n\n最後に、ゴミの日を教えてくれる？\n（例：「可燃ゴミは月曜日」と一つずつ教えてな。終わったら「おわり」と入力してや）` });
      }
      case 'awaiting_garbage'; {
        if (userText === 'おわり' || userText === 'なし') {
          user.setupState = 'complete';
          await updateUser(userId, user);
          return client.replyMessage(event.replyToken, { type: 'text', text: '設定おおきに！これで全部や！' });
        }
        const garbageMatch = userText.match(/(.+?ゴミ)は?(\S+?)曜日?/);
        if (garbageMatch) {
          const dayMap = { '日':0, '月':1, '火':2, '水':3, '木':4, '金':5, '土':6 };
          const [ , garbageType, dayOfWeek ] = garbageMatch;
          if (dayMap[dayOfWeek] !== undefined) {
            user.garbageDay[dayMap[dayOfWeek]] = garbageType.trim();
            await updateUser(userId, user);
            return client.replyMessage(event.replyToken, { type: 'text', text: `了解、「${garbageType.trim()}」が${dayOfWeek}曜日やね。他にもあったら教えてな。（終わったら「おわり」と入力）` });
          }
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、うまく聞き取れへんかったわ。「〇〇ゴミは△曜日」の形で教えてくれる？` });
      }
    }
    return;
  }

  if (userText.includes('ご飯') || userText.includes('ごはん')) {
    return client.replyMessage(event.replyToken, getRecipe());
  }
  const reminderResult = chrono.ja.parse(userText);
  if (reminderResult.length > 0) {
    const reminderDate = reminderResult[0].start.date();
    const task = userText.replace(reminderResult[0].text, '').trim();
    if (task) {
      user.reminders.push({ date: reminderDate.toISOString(), task });
      await updateUser(userId, user);
      return client.replyMessage(event.replyToken, { type: 'text', text: `あいよ！\n${reminderDate.toLocaleString('ja-JP')}に「${task}」やね。覚えとく！` });
    }
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
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