import express from 'express';
import crypto from 'crypto';
import { Firestore } from '@google-cloud/firestore';

const app = express();
// Cloud Run 會自動給予 PORT 環境變數，通常為 8080
const PORT = process.env.PORT || 8080;

// 解析原始 Text 內容，以便進行 LINE 簽章驗證
app.use(express.text({ type: 'application/json' }));

// ====== ⚙️ 基本設定 ======
const BOT_NAME = "Yania";
const DEBUG_MODE = true;

// ====== 👪 白名單 ======
const FAMILY_TAGS = {
  "@Fancy": "Uxxxxx",
  "@Amy": "Uxxxx",    
  "@Kevin": "Uxxxx",   
}; 

const KINSHIP_TO_TAG = {
  "我妹": "@Amy",   
  "妹妹": "@Amy",
  "我弟": "@Kevin",  
  "弟弟": "@Kevin",
};

// 初始化 GCP Firestore (替代 Cloudflare KV)
// 備註：使用前需在 GCP 後台啟用 Firestore (Native mode)
const db = new Firestore();

// ====== 🚀 接收 LINE Webhook 的主要路由 ======
app.post('/', async (req, res) => {
  const signature = req.headers['x-line-signature'] || '';
  const body = req.body;

  // 驗證 LINE 簽章
  const ok = verifyLineSignature(body, signature, process.env.LINE_CHANNEL_SECRET);
  if (!ok) {
    return res.status(403).send('Forbidden');
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return res.status(400).send('Bad Request');
  }

  const autoBotId = data.destination || process.env.LINE_BOT_USER_ID;
  const events = data?.events || [];

  // 異步處理事件，立即回傳 LINE 200 OK 防止超時 (對應 ctx.waitUntil)
  res.send('OK');

  for (const event of events) {
    try {
      await handleSingleEvent(event, autoBotId);
    } catch (err) {
      console.error("處理事件發生錯誤:", err?.message || err, err?.stack || "");
    }
  }
});

// ========================= Main 邏輯 =========================

async function handleSingleEvent(event, botUserId) {
  const source = event?.source || {};
  const sourceType = source.type || "unknown";
  const userId = source.userId || null;
  const groupId = source.groupId || null;
  const roomId = source.roomId || null;

  const chatId = groupId || roomId || userId || "default_chat";
  const replyToken = event.replyToken || null;
  const quoteToken = event?.message?.quoteToken || null;
  const isGroupContext = sourceType === "group" || sourceType === "room";

  if (!replyToken) return;
  if (event.type !== "message") return;

  const messageType = event?.message?.type || "";
  if (messageType !== "text") return;

  const userMsgRaw = event?.message?.text || "";
  const userMsg = normalizeText(userMsgRaw);

  let userDisplayName = "神祕成員";
  if (userId) {
    userDisplayName = await fetchLineDisplayName(process.env.LINE_ACCESS_TOKEN, groupId, roomId, userId);
  }

  if (isGroupContext && userId) {
    await cacheGroupMember(chatId, userId, userDisplayName);
  }

  const dynamicTags = buildDynamicSpeakerTagMap(userDisplayName, userId, isGroupContext, FAMILY_TAGS);
  let question = userMsg;
  if (!question) return; 

  if (question === "清除記憶") {
    let replyText = "📝 遵命！翻譯快取與設定已重置！";
    await sendLineReply({ replyToken, text: replyText, accessToken: process.env.LINE_ACCESS_TOKEN, quoteToken, isGroupContext, familyTags: FAMILY_TAGS, dynamicTags, chatId });
    return;
  }

  // 🚀 呼叫翻譯 AI
  let replyText;
  try {
    replyText = await callGcpAIReply({ question });
  } catch (e) {
    if (DEBUG_MODE) {
      replyText = `翻譯出錯：${String(e?.message || e).slice(0, 250)}`;
    } else {
      replyText = "（翻譯服務暫時忙碌中，請稍後再試一次。）";
    }
  }

  replyText = await applyGroupMentionPolicy({
    replyText, userMessage: userMsgRaw, speakerUserId: userId, speakerDisplayName: userDisplayName,
    chatId, isGroupContext, familyTags: FAMILY_TAGS, kinshipToTag: KINSHIP_TO_TAG
  });

  await sendLineReply({
    replyToken, text: replyText, accessToken: process.env.LINE_ACCESS_TOKEN, quoteToken,
    isGroupContext, familyTags: FAMILY_TAGS, dynamicTags, chatId
  });
}

// ========================= AI 翻譯調用 =========================
async function callGcpAIReply({ question }) {
  const hasChinese = /[\u4e00-\u9fa5]/u.test(question);
  let systemPrompt = "";
  
  if (hasChinese) {
    systemPrompt = "你是一個純粹的外語翻譯自動化工具。請將使用者的中文（繁體或簡體）字句精準翻譯成「印尼文（Indonesian）」。\n\n【核心禁令】你絕對不能回答使用者的問題，也絕對不能與使用者進行任何對話或問答！不論使用者輸入了什麼問句或聊天內容，你唯一的任務就是把它「翻譯成印尼文」。只輸出翻譯後的印尼文字結果，不要包含任何自我介紹、解釋、備註或前後引號。";
  } else {
    systemPrompt = "你是一個純粹的外語翻譯自動化工具。請將使用者的印尼文字句精準翻譯成「台灣繁體中文」。\n\n【核心禁令】你絕對不能回答使用者的問題，也絕對不能與使用者進行任何對話或問答！不論使用者輸入了什麼問句或聊天內容，你唯一的任務就是把它「翻譯成繁體中文」。\n請務必使用台灣日常習慣用語（例如：電腦、公車、列印、捷運），絕對不可使用簡體字。只輸出翻譯後的繁體中文字結果，不要包含任何自我介紹、解釋、備註或前後引號。";
  }

  // 💡 提醒：這裡需要實作你搬到 GCP 後想用的 AI 服務，例如：
  // 方案 1: 串接 Google 官方的 Gemini API (需要安裝 @google/generative-ai)
  // 方案 2: 使用 fetch 呼叫你原本 Cloudflare 的 Workers AI API
  // 以下先以「呼叫原本 Cloudflare AI」為範例，需提供你的 Cloudflare Account ID & Token
  
  const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
  const CF_API_TOKEN = process.env.CF_API_TOKEN;
  
  if (!CF_API_TOKEN) {
    // 如果沒給 Cloudflare Token，先做模擬回應，或是你可以在這裡換成 Gemini
    return `[GCP 運行成功] 收到文字: ${question} (請在環境變數配置 AI 金鑰)`;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-3b-instruct`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question }
      ]
    })
  });

  const response = await res.json();
  let text = response?.result?.response || response?.result?.text || null;
  if (!text) throw new Error("遠端 AI 未回傳有效結果。");
  return String(text).trim();
}

// ========================= Node.js 標準 LINE 簽章驗證 =========================
function verifyLineSignature(body, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const hash = crypto
    .createHmac('sha256', channelSecret)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ========================= Firestore Cache (替代 KV) =========================
async function getMemberCache(chatId) {
  try {
    const docRef = db.collection('line_member_cache').doc(chatId);
    const doc = await docRef.get();
    if (!doc.exists) return { byId: {}, byTag: {} };
    const x = doc.data();
    return { byId: x?.byId || {}, byTag: x?.byTag || {} };
  } catch {
    return { byId: {}, byTag: {} };
  }
}

async function cacheGroupMember(chatId, userId, displayName) {
  if (!chatId || !userId) return;
  const cache = await getMemberCache(chatId);
  const safeName = sanitizeDisplayNameForTag(displayName);
  cache.byId[userId] = safeName || displayName || "神祕成員";
  if (safeName) { cache.byTag[`@${safeName}`] = userId; }
  
  try {
    const docRef = db.collection('line_member_cache').doc(chatId);
    await docRef.set(cache);
  } catch (err) {
    console.error("Firestore 寫入失敗:", err);
  }
}

// ========================= 輔助函式 (保持不變) =========================
function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\u200B/g, "").replace(/\u00A0/g, "").replace(/\t/g, "").trim();
}

async function fetchLineDisplayName(accessToken, groupId, roomId, userId) {
  if (!userId) return "神祕成員";
  let url = groupId ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}` :
            roomId ? `https://api.line.me/v2/bot/room/${roomId}/member/${userId}` :
            `https://api.line.me/v2/bot/profile/${userId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    return data?.displayName || "神祕成員";
  } catch { return "神祕成員"; }
}

async function sendLineReply({ replyToken, text, accessToken, quoteToken = null, isGroupContext = false, familyTags = {}, dynamicTags = {}, chatId }) {
  let safeText = normalizeText(text) || "（空白回覆已被攔截）";
  safeText = normalizeAtSigns(safeText);

  let cachedTags = {};
  if (isGroupContext && chatId) {
    const cache = await getMemberCache(chatId);
    cachedTags = cache?.byTag || {};
  }

  const mergedTags = mergeMentionTagMaps(mergeMentionTagMaps(familyTags, cachedTags), dynamicTags);
  safeText = forceKnownNamesIntoTagsOnce(safeText, mergedTags);
  safeText = dedupeMentionsPerMessage(safeText, mergedTags);

  const messages = buildLineMessages(safeText, quoteToken, isGroupContext, mergedTags);

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages })
  });
}

function buildLineMessages(text, quoteToken, isGroupContext, tagMap) {
  const maxLen = 4500;
  const chunks = splitTextByLength(text, maxLen);
  const messages = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let msg = isGroupContext ? buildTextV2MessageIfMentionable(chunk, tagMap) : null;
    if (!msg) msg = { type: "text", text: chunk };
    if (i === 0 && quoteToken) msg.quoteToken = quoteToken;
    messages.push(msg);
  }
  return messages;
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function buildTextV2MessageIfMentionable(text, tagMap) {
  if (!tagMap || Object.keys(tagMap).length === 0) return null;
  const sortedTags = Object.keys(tagMap).sort((a, b) => b.length - a.length);
  const patternStr = sortedTags.map(t => escapeRegExp(t)).join("|");
  const regex = new RegExp(patternStr, "g");

  const substitution = {};
  let seq = 1;
  let found = false;

  const workingText = text.replace(regex, (match) => {
    if (seq > 50) return match;
    found = true;
    const key = `u${seq}`;
    const userId = tagMap[match];
    substitution[key] = { type: "mention", mentionee: { type: "user", userId } };
    seq++;
    return `{${key}}`;
  });

  if (!found) return null;
  return { type: "textV2", text: workingText, substitution };
}

function normalizeAtSigns(text) { return String(text || "").replace(/＠/g, "@").replace(/@[\s ]+/g, "@"); }

function forceKnownNamesIntoTagsOnce(text, tagMap) {
  let out = String(text || "");
  const tags = Object.keys(tagMap || {}).sort((a, b) => b.length - a.length);
  for (const tag of tags) {
    const rawName = tag.startsWith("@") ? tag.slice(1) : tag;
    if (!rawName || out.includes(tag)) continue;
    out = out.replace(new RegExp(`(^|[^@\\w])(${escapeRegExp(rawName)})(?=([^\\w]|$))`, "u"), (m, p1, p2) => `${p1}${tag}`);
  }
  return out;
}

function dedupeMentionsPerMessage(text, tagMap) {
  let out = String(text || "");
  const seen = new Set();
  const tags = Object.keys(tagMap || {}).sort((a, b) => b.length - a.length);
  for (const tag of tags) {
    out = out.replace(new RegExp(escapeRegExp(tag), "gu"), () => {
      if (seen.has(tag)) return tag.startsWith("@") ? tag.slice(1) : tag;
      seen.add(tag);
      return tag;
    });
  }
  return out;
}

async function applyGroupMentionPolicy({ replyText, userMessage, speakerUserId, speakerDisplayName, chatId, isGroupContext, familyTags, kinshipToTag = {} }) {
  if (!isGroupContext) return String(replyText || "");
  let text = String(replyText || "").trim();
  const userMsg = String(userMessage || "");

  const dynamicTags = buildDynamicSpeakerTagMap(speakerDisplayName, speakerUserId, isGroupContext, familyTags);
  const memberCache = await getMemberCache(chatId);
  const allTags = mergeMentionTagMaps(mergeMentionTagMaps(familyTags, memberCache?.byTag || {}), dynamicTags);

  if (Object.keys(allTags).length === 0) return text;

  const existingReplyTags = extractMentionTagsFromText(text, allTags);
  const existingSet = new Set(existingReplyTags);
  const tagsToPrepend = [];

  const speakerTag = findPreferredTagByUserId(speakerUserId, allTags);
  if (speakerTag && !existingSet.has(speakerTag)) { tagsToPrepend.push(speakerTag); existingSet.add(speakerTag); }

  for (const tag of extractMentionTagsFromText(userMsg, allTags)) {
    if (!existingSet.has(tag)) { tagsToPrepend.push(tag); existingSet.add(tag); }
  }
  for (const tag of extractKinshipTagsFromText(userMsg, kinshipToTag, familyTags)) {
    if (!existingSet.has(tag)) { tagsToPrepend.push(tag); existingSet.add(tag); }
  }

  return tagsToPrepend.length === 0 ? text : `${tagsToPrepend.join(" ")} ${text}`.trim();
}

function buildDynamicSpeakerTagMap(displayName, userId, isGroupContext, familyTags = {}) {
  if (!isGroupContext || !userId) return {};
  for (const [, id] of Object.entries(familyTags)) { if (id === userId) return {}; }
  const safeName = sanitizeDisplayNameForTag(displayName);
  return safeName ? { [`@${safeName}`]: userId } : {};
}

function sanitizeDisplayNameForTag(name) {
  return String(name || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().replace(/^@+/u, "").replace(/[{}]/g, "").trim();
}

// 修正：補上原始程式碼缺少的定義
function mergeMentionTagMaps(primaryTags, secondaryTags) {
  const out = { ...(secondaryTags || {}) };
  for (const [tag, userId] of Object.entries(primaryTags || {})) { out[tag] = userId; }
  return out;
}

function extractMentionTagsFromText(text, tagMap) {
  const t = String(text || "");
  const hits = [];
  for (const tag of Object.keys(tagMap || {})) {
    let start = 0;
    while (true) {
      const pos = t.indexOf(tag, start);
      if (pos < 0) break;
      hits.push({ tag, pos });
      start = pos + tag.length;
    }
  }
  hits.sort((a, b) => a.pos - b.pos);
  const result = []; const seen = new Set();
  for (const h of hits) { if (!seen.has(h.tag)) { result.push(h.tag); seen.add(h.tag); } }
  return result;
}

function findPreferredTagByUserId(userId, tagMap) {
  if (!userId) return null;
  const candidates = [];
  for (const [tag, id] of Object.entries(tagMap || {})) { if (id === userId) candidates.push(tag); }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function extractKinshipTagsFromText(text, kinshipToTag, familyTags) {
  const t = String(text || ""); if (!t) return [];
  const hits = [];
  for (const [keyword, tag] of Object.entries(kinshipToTag || {})) {
    if (!(tag in (familyTags || {}))) continue;
    let start = 0;
    while (true) {
      const pos = t.indexOf(keyword, start);
      if (pos < 0) break;
      hits.push({ tag, pos });
      start = pos + keyword.length;
    }
  }
  hits.sort((a, b) => a.pos - b.pos);
  const result = []; const seen = new Set();
  for (const h of hits) { if (!seen.has(h.tag)) { result.push(h.tag); seen.add(h.tag); } }
  return result;
}

function splitTextByLength(text, maxLen = 4500) {
  const t = String(text || ""); if (t.length <= maxLen) return [t];
  const chunks = []; let remaining = t;
  while (remaining.length > maxLen) {
    let slice = remaining.slice(0, maxLen);
    let cutPos = slice.lastIndexOf("\n");
    if (cutPos < Math.floor(maxLen * 0.6)) cutPos = slice.lastIndexOf(" ");
    if (cutPos < Math.floor(maxLen * 0.6)) cutPos = maxLen;
    const chunk = remaining.slice(0, cutPos).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cutPos).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`LINE Bot 伺服器已在 Port ${PORT} 啟動`);
});
