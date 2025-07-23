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
const { formatInTimeZone } = require('date-fns-tz');

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
  fuse = new Fuse(cityList, {
    keys: ['city', 'prefecture'],
    threshold: 0.3,
  });
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
  if (!fuse) {
    console.error('Fuse.jsが初期化されていないため、都市検索を実行できません。');
    return null;
  }
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
const getTrainStatus = async (trainLineName) => {
  const lineUrlMap = {
    '山手線': 'https://transit.yahoo.co.jp/diainfo/line/21/0',
    '京浜東北線': 'https://transit.yahoo.co.jp/diainfo/line/22/0',
    '中央線快速電車': 'https://transit.yahoo.co.jp/diainfo/line/26/0',
    '埼京線': 'https://transit.yahoo.co.jp/diainfo/line/31/0',
  };
  const url = lineUrlMap[trainLineName];
  if (!url) { return `${trainLineName}の運行情報は、ごめん、まだ調べられへんみたい…`; }
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const status = $('#mdServiceStatus dt').text().trim();
    return status ? `今日の${trainLineName}は、『${status}』みたいやで。` : `${trainLineName}の運行情報、うまく取得できんかったわ。`;
  } catch (error) { console.error("Train Info Scraping Error:", error); return `${trainLineName}の運行情報、うまく取得できんかったわ。`; }
};

// ----------------------------------------------------------------
// 5. 定期実行するお仕事 (スケジューラー)
// ----------------------------------------------------------------
cron.schedule('0 8 * * *', async () => {
  try {
    const res = await pool.query("SELECT user_id, data FROM users WHERE data->>'setupState' = 'complete'");
    for (const row of res.rows) {
      const userId = row.user_id;
      const user = row.data;
      let morningMessage = 'おはよー！朝やで！\n';
      const weatherInfo = await getWeather(user.cityId);
      morningMessage += `\n${weatherInfo}\n`;
      const todayIndex = new Date().getDay();
      const garbageInfo = user.garbageDay[todayIndex];
      if (garbageInfo) { morningMessage += `\n今日は「${garbageInfo}」の日やで！忘れんといてや！🚮\n`; }
      if (user.trainLine) {
        const trainInfo = await getTrainStatus(user.trainLine);
        morningMessage += `\n${trainInfo}\n`;
      }
      await client.pushMessage(userId, { type: 'text', text: morningMessage });
    }
  } catch (err) { console.error('朝の通知処理でエラー:', err); }
}, { timezone: "Asia/Tokyo" });

cron.schedule('* * * * *', async () => {
  try {
    const res = await pool.query("SELECT user_id, data FROM users WHERE jsonb_array_length(data->'reminders') > 0");
    for (const row of res.rows) {
      const userId = row.user_id;
      const user = row.data;
      const now = new Date();
      const dueReminders = [];
      const remainingReminders = [];
      user.reminders.forEach(reminder => {
        if (new Date(reminder.date) <= now) { dueReminders.push(reminder); } 
        else { remainingReminders.push(reminder); }
      });
      if (dueReminders.length > 0) {
        user.reminders = remainingReminders;
        await updateUser(userId, user);
        for (const reminder of dueReminders) {
          await client.pushMessage(userId, { type: 'text', text: `おかんやで！時間やで！\n\n「${reminder.task}」\n\n忘れたらあかんで！` });
        }
      }
    }
  } catch (err) { console.error('リマインダー処理でエラー:', err); }
}, { timezone: "Asia/Tokyo" });

// ----------------------------------------------------------------
// 6. LINEからのメッセージを処理するメインの部分
// ----------------------------------------------------------------
const handleEvent = async (event) => {
  if (event.type === 'follow') {
    const userId = event.source.userId;
    await createUser(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: '友達追加ありがとうな！設定を始めるで！\n「天気予報」に使う市区町村の名前を教えてな。（例：札幌、横浜）'});
  }
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
    switch (user.setupState) {
      case 'awaiting_location': {
        const cityInfo = findCityId(userText);
        if (!cityInfo) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、その都市の天気予報IDが見つけられへんかったわ。日本の市区町村名で試してくれるかな？' }); }
        user.location = cityInfo.name;
        user.cityId = cityInfo.id;
        user.prefecture = cityInfo.prefecture;
        user.setupState = 'awaiting_time';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `おおきに！地域は「${user.location}」で覚えたで。\n\n次は、毎朝の通知は何時がええ？` });
      }
      case 'awaiting_time': {
        user.notificationTime = userText;
        user.setupState = 'awaiting_route';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `了解！朝の通知は「${userText}」やね。\n\n次は、普段利用する経路を「〇〇駅から〇〇駅」のように教えてくれる？` });
      }
      case 'awaiting_route': {
        const match = userText.match(/(.+?)駅?から(.+)駅?$/);
        if (!match) { return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、うまく聞き取れへんかった。「〇〇駅から〇〇駅」の形でもう一度教えてくれる？' }); }
        const [ , departureName, arrivalName ] = match;
        const departureStations = await findStation(departureName.trim());
        const arrivalStations = await findStation(arrivalName.trim());
        if (departureStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${departureName}」という駅が見つからへんかったわ。` }); }
        if (arrivalStations.length === 0) { return client.replyMessage(event.replyToken, { type: 'text', text: `ごめん、「${arrivalName}」という駅が見つからへんかったわ。` }); }
        const departure = departureStations.find(s => s.prefecture === user.prefecture) || departureStations[0];
        const arrival = arrivalStations.find(s => s.prefecture === user.prefecture) || arrivalStations[0];
        user.departureStation = departure.name; user.arrivalStation = arrival.name;
        const departureLines = departure.line ? departure.line.split(' ') : [];
        const arrivalLines = arrival.line ? arrival.line.split(' ') : [];
        const commonLines = departureLines.filter(line => arrivalLines.includes(line));
        if (commonLines.length === 0) {
          user.trainLine = null;
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
      case 'awaiting_line_selection': {
        user.trainLine = userText;
        user.setupState = 'awaiting_garbage';
        await updateUser(userId, user);
        return client.replyMessage(event.replyToken, { type: 'text', text: `「${user.trainLine}」やね、覚えたで！\n\n最後に、ゴミの日を教えてくれる？` });
      }
      case 'awaiting_garbage': {
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
        return client.replyMessage(event.replyToken, { type: 'text', text: 'ごめん、うまく聞き取れへんかったわ。「〇〇ゴミは△曜日」の形で教えてくれる？' });
      }
    }
    return;
  }
  if (userText.includes('リマインド') || userText.includes('思い出させて')) {
    let reminderDate = null;
    let task = '';
    const japanTimeZone = 'Asia/Tokyo';
    const referenceDate = new Date();
    const relativeMatch = userText.match(/(\d+)\s*(分|時間)後/);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];
      let targetDate = new Date();
      if (unit === '分') { targetDate.setMinutes(targetDate.getMinutes() + amount); }
      else if (unit === '時間') { targetDate.setHours(targetDate.getHours() + amount); }
      reminderDate = targetDate;
      task = userText.replace(relativeMatch[0], '').replace(/ってリマインドして?/, '').replace(/と思い出させて?/, '').trim();
    } else {
      const reminderResult = chrono.ja.parse(userText, referenceDate, { forwardDate: true });
      if (reminderResult.length > 0) {
        reminderDate = reminderResult[0].start.date();
        task = userText.replace(reminderResult[0].text, '').replace(/ってリマインドして?/, '').replace(/と思い出させて?/, '').trim();
      }
    }
    task = task.replace(/^[にでをは]/, '').trim();
    if (reminderDate && task) {
      user.reminders.push({ date: reminderDate.toISOString(), task });
      await updateUser(userId, user);
      const formattedDate = formatInTimeZone(reminderDate, japanTimeZone, 'yyyy/MM/dd HH:mm');
      return client.replyMessage(event.replyToken, { type: 'text', text: `あいよ！\n${formattedDate}に「${task}」やね。覚えとく！` });
    }
  }
  if (userText.includes('ご飯') || userText.includes('ごはん')) {
    return client.replyMessage(event.replyToken, getRecipe());
  }
  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
};

// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const setupDatabase = async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (user_id VARCHAR(255) PRIMARY KEY, data JSONB);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS api_usage (usage_date DATE PRIMARY KEY,call_count INTEGER NOT NULL DEFAULT 0);`);
  console.log('データベースのテーブル準備OK！');
};
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
        client.replyMessage(req.body.events[0].replyToken, { type: 'text', text: 'ごめん、ちょっと調子が悪いみたい…。' });
      }
      res.status(500).end();
    });
});

app.listen(PORT, async () => {
  await setupDatabase();
  console.log(`おかんAI、ポート${PORT}で待機中...`);
});