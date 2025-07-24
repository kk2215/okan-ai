require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Client: MapsClient } = require('@googlemaps/google-maps-services-js');

// --- 設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const Maps_API_KEY = process.env.Maps_API_KEY;

const client = new Client(config);
const mapsClient = new MapsClient({});

// --- 経路検索の専門家 ---
const getRouteInfo = async (departure, arrival) => {
  if (!Maps_API_KEY) {
    return 'ごめん、GoogleのAPIキーが設定されてへんみたい…';
  }
  try {
    console.log(`[1] Geocoding for Departure: "${departure}"`);
    const departureResponse = await mapsClient.geocode({ params: { address: departure, language: 'ja', key: Maps_API_KEY } });
    if (departureResponse.data.status !== 'OK') { return `ごめん、「${departure}」の場所が見つけられへんかった…`; }
    const departurePlaceId = departureResponse.data.results[0].place_id;

    console.log(`[2] Geocoding for Arrival: "${arrival}"`);
    const arrivalResponse = await mapsClient.geocode({ params: { address: arrival, language: 'ja', key: Maps_API_KEY } });
    if (arrivalResponse.data.status !== 'OK') { return `ごめん、「${arrival}」の場所が見つけられへんかった…`; }
    const arrivalPlaceId = arrivalResponse.data.results[0].place_id;

    console.log(`[3] Searching directions with Place IDs...`);
    const directionsResponse = await mapsClient.directions({
      params: {
        origin: `place_id:${departurePlaceId}`,
        destination: `place_id:${arrivalPlaceId}`,
        mode: 'transit',
        language: 'ja',
        departure_time: 'now',
        key: Maps_API_KEY,
      }
    });

    if (directionsResponse.data.status !== 'OK') {
      return `ごめん、経路が見つけられへんかったわ… (Googleからの返答: ${directionsResponse.data.status})`;
    }

    const leg = directionsResponse.data.routes[0].legs[0];
    const transitSteps = leg.steps.filter(step => step.travel_mode === 'TRANSIT');
    if (transitSteps.length === 0) { return 'ごめん、その2駅間の電車経路は見つけられへんかった…'; }

    let message = `「${leg.start_address.split('、')[0]}」から「${leg.end_address.split('、')[0]}」までやね。\n`;
    if (transitSteps.length === 1) {
      message += `「${transitSteps[0].transit_details.line.name}」に乗って行くんやね。`;
    } else {
      message += `「${transitSteps[0].transit_details.line.name}」で「${transitSteps[0].transit_details.arrival_stop.name}」まで行って、そこから「${transitSteps[1].transit_details.line.name}」に乗り換えるんやね。`;
    }
    return message;

  } catch (error) {
    console.error("--- Google Maps API Error ---", error.response?.data || error.message);
    return `ごめん、経路の検索中にエラーが出てしもうた…\n『${error.response?.data?.error_message || '原因不明'}』`;
  }
};

// --- AIのメインの動き ---
const handleEvent = async (event) => {
  if (event.type !== 'message' || event.message.type !== 'text') { return; }

  const userText = event.message.text.trim();
  const match = userText.match(/(.+)から(.+)/);

  if (match) {
    const [ , departure, arrival ] = match;
    const replyText = await getRouteInfo(departure.trim(), arrival.trim());
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  } else {
    return client.replyMessage(event.replyToken, { type: 'text', text: '「〇〇から〇〇」の形で教えてな。' });
  }
};

// --- サーバー起動 ---
const app = express();
const PORT = process.env.PORT || 3000;
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});
app.listen(PORT, () => {
  console.log(`Okan AI Final Test listening on port ${PORT}`);
});