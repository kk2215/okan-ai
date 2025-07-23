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
  console.error('★★★★ 致命的エラー: city-list.jsonの読み込みに失敗しました。 ★★★★');
}

// ----------------------------------------------------------------
// 3. データベース関数
// ----------------------------------------------------------------
const getUser = async (userId) => { /* ... */ };
const createUser = async (userId) => { /* ... */ };
const updateUser = async (userId, userData) => { /* ... */ };

// ----------------------------------------------------------------
// 4. 各機能の部品 (ヘルパー関数)
// ----------------------------------------------------------------
const findCityId = (locationName) => { /* ... */ };
const getWeather = async (cityId) => { /* ... */ };
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

  if (userText === 'リセット') { /* ... */ }

  let user = await getUser(userId);
  if (!user) { /* ... */ }

  if (user.setupState && user.setupState !== 'complete') {
    // ... (設定フローのswitch文) ...
    return;
  }

  // ▼▼▼▼▼ リマインダー処理をここから全面的に書き換え ▼▼▼▼▼
  if (userText.includes('リマインド') || userText.includes('思い出させて')) {
    let reminderDate = null;
    let task = '';
    
    // 現在時刻を日本時間として取得
    const nowInJapan = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

    const relativeMatch = userText.match(/(\d+)\s*(分|時間)後/);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];
      
      let targetDate = new Date(nowInJapan);
      if (unit === '分') {
        targetDate.setMinutes(targetDate.getMinutes() + amount);
      } else if (unit === '時間') {
        targetDate.setHours(targetDate.getHours() + amount);
      }
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
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `あいよ！\n${reminderDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}に「${task}」やね。覚えとく！`
      });
    }
  }
  // ▲▲▲▲▲ リマインダー処理ここまで ▲▲▲▲▲

  if (userText.includes('ご飯') || userText.includes('ごはん')) {
    return client.replyMessage(event.replyToken, getRecipe());
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: 'うんうん。' });
};

// ----------------------------------------------------------------
// 7. サーバーを起動
// ----------------------------------------------------------------
const setupDatabase = async () => { /* ... */ };
const app = express();
// ... (最終版のサーバー起動コード) ...