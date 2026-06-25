// index.js
const express = require('express');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

const app = express();
// 接收 LINE 傳來的原始 Body (verifyLineSignature 需要)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ====== ⚙️ 基本設定 ======
const BOT_NAME = "Yania"; 

// ✅ 除錯開關：拍片/除錯 = true；正式上線 = false
const DEBUG_MODE = true;

// ====== 👪 白名單 ======
const FAMILY_TAGS = {
  "@Fancy": "Uxxxxx", 
  "@Amy": "Uxxxx",    
  "@Kevin": "Uxxxx",   
}; 

// ====== 👪 親屬稱呼 → tag ======
const KINSHIP_TO_TAG = {
  "我妹": "@Amy",   
  "妹妹": "@Amy",
  "我弟": "@Kevin",  
  "弟弟": "@Kevin",
};

// ====== 💾 記憶體快取 (取代原本的 Cloudflare KV) ======
const MEMORY_CACHE = new Map();

// ========================================================

app.post('/webhook', async (req, res) => {
  // 1. 驗證 LINE 簽章
  const signature = req.headers["x-line-signature"] || "";
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  
  if (!verifyLineSignature(req.rawBody, signature, channelSecret)) {
    return res.status(403).send("Forbidden");
  }

  // 2. 解析事件
  const data = req.body;
  const autoBotId = data.destination || process.env.LINE_BOT_USER_ID;
  const events = data?.events || [];

  // Cloud Run 是標準 Node.js 環境，這裡直接執行異步處理，並立刻回傳 200 OK 給 LINE
  res.status(200).send("OK");

  for (const event of events) {
    try {
      await handleSingleEvent(event, autoBotId);
    } catch (err) {
      console.error("處理事件發生錯誤:", err?.message || err);
    }
  }
});

// ========================= Main =========================

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
    userDisplayName = await fetchLineDisplayName(groupId, roomId, userId);
  }

  if (isGroupContext && userId) {
    await cacheGroupMember(chatId, userId, userDisplayName);
  }

  const dynamicTags = buildDynamicSpeakerTagMap(userDisplayName, userId, isGroupContext, FAMILY_TAGS);

  let question = userMsg;
  if (!question) return; 

  if (question === "清除記憶") {
    MEMORY_CACHE.delete(`member:${chatId}`);
    let replyText = "📝 遵命！翻譯快取與設定已重置！";
    await sendLineReply({ replyToken, text: replyText, quoteToken, isGroupContext, dynamicTags, chatId });
    return;
  }

  // 🚀 呼交 Google Vertex AI (Gemini) 進行翻譯
  let replyText;
  try {
    replyText = await callGoogleGeminiReply(question);
  } catch (e) {
    if (DEBUG_MODE) {
      replyText = `翻譯出錯（Gemini AI）：${String(e?.message || e).slice(0, 250)}`;
    } else {
      replyText = "（翻譯服務暫時忙碌中，請稍後再試一次。）";
    }
  }

  replyText = await applyGroupMentionPolicy({
    replyText, userMessage: userMsgRaw, speakerUserId: userId, speakerDisplayName: userDisplayName,
    chatId, isGroupContext, kinshipToTag: KINSHIP_TO_TAG
  });

  await sendLineReply({
    replyToken, text: replyText, quoteToken, isGroupContext, dynamicTags, chatId
  });
}

// ========================= Google Vertex AI (Gemini 2.5 Flash) =========================

async function callGoogleGeminiReply(question) {
  // 初始化 Google Gen AI SDK
  const ai = new GoogleGenAI();
  
  const hasChinese = /[\u4e00-\u9fa5]/u.test(question);
  let systemPrompt = "";
  
  if (hasChinese) {
    systemPrompt = "你是一個純粹的外語翻譯自動化工具。請將使用者的中文（繁體或簡體）字句精準翻譯成「印尼文（Indonesian）」。\n\n【核心禁令】你絕對不能回答使用者的問題，也絕對不能與使用者進行任何對話或問答！不論使用者輸入了什麼問句或聊天內容，你唯一的任務就是把它「翻譯成印尼文」。只輸出翻譯後的印尼文字結果，不要包含任何自我介紹、解釋、備註或前後引號。";
  } else {
    systemPrompt = "你是一個純粹的外語翻譯自動化工具。請將使用者的印尼文字句精準翻譯成「台灣繁體中文」。\n\n【核心禁令】你絕對不能回答使用者的問題，也絕對不能與使用者進行任何對話或問答！不論使用者輸入了什麼問句或聊天內容，你唯一的任務就是把它「翻譯成繁體中文」。\n請務必使用台灣日常習慣用語（例如：電腦、公車、列印、捷運），絕對不可使用簡體字。只輸出翻譯後的繁體中文字結果，不要包含任何自我介紹、解釋、備註或前後引號。";
  }

  // 呼叫 Gemini 2.5 Flash 
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: question,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.3
    }
  });

  const text = response.text;
  if (!text) throw new Error("翻譯模型未回傳有效結果。");
  return String(text).trim();
}

// ========================= LINE Signature =========================

function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature || !channelSecret) return false;
  const hash = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return hash === signature;
}

// ========================= Memory Cache =========================

function memberCacheKey(chatId) { return `member:${chatId}`; }

function getMemberCache(chatId) {
  const key = memberCacheKey(chatId);
  if (!MEMORY_CACHE.has(key)) return { byId: {}, byTag: {} };
  return MEMORY_CACHE.get(key);
}

function cacheGroupMember(chatId, userId, displayName) {
  if (!chatId || !userId) return;
  const cache = getMemberCache(chatId);
  const safeName = sanitizeDisplayNameForTag(displayName);
  cache.byId[userId] = safeName || displayName || "神祕成員";
  if (safeName) { cache.byTag[`@${safeName}`] = userId; }
  MEMORY_CACHE.set(memberCacheKey(chatId), cache);
}

// ========================= Message Parsing =========================

function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\u200B/g, "").replace(/\u00A0/g, "").replace(/\t/g, "").trim();
}

// ========================= LINE Profile =========================

async function fetchLineDisplayName(groupId, roomId, userId) {
  if (!userId) return "神祕成員";
  let url = groupId ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}` :
            roomId ? `https://api.line.me/v2/bot/room/${roomId}/member/${userId}` :
            `https://api.line.me/v2/bot/profile/${userId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}` } });
    const data = await res.json();
    return data?.displayName || "神祕成員";
  } catch { return "神祕成員"; }
}

// ========================= LINE Reply / Mention =========================

async function sendLineReply({ replyToken, text, quoteToken = null, isGroupContext = false, dynamicTags = {}, chatId }) {
  let safeText = normalizeText(text) || "（空白回覆已被攔截）";
  safeText = normalizeAtSigns(safeText);

  let cachedTags = {};
  if (isGroupContext && chatId) {
    const cache = getMemberCache(chatId);
    cachedTags = cache?.byTag || {};
  }

  const mergedTags = mergeMentionTagMaps(mergeMentionTagMaps(FAMILY_TAGS, cachedTags), dynamicTags);
  safeText = forceKnownNamesIntoTagsOnce(safeText, mergedTags);
  safeText = dedupeMentionsPerMessage(safeText, mergedTags);

  const messages = buildLineMessages(safeText, quoteToken, isGroupContext, mergedTags);

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}` },
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
    const rawName = tag.startsWith("@") ? tag.slice(1) : tag;
    out = out.replace(new RegExp(escapeRegExp(tag), "gu"), () => {
      if (seen.has(tag)) return rawName;
      seen.add(tag);
      return tag;
    });
  }
  return out;
}

// ========================= Mention Policy =========================

async function applyGroupMentionPolicy({ replyText, userMessage, speakerUserId, speakerDisplayName, chatId, isGroupContext, kinshipToTag = {} }) {
  if (!isGroupContext) return String(replyText || "");
  let text = String(replyText || "").trim();
  const userMsg = String(userMessage || "");

  const dynamicTags = buildDynamicSpeakerTagMap(speakerDisplayName, speakerUserId, isGroupContext, FAMILY_TAGS);
  const memberCache = getMemberCache(chatId);
  const allTags = mergeMentionTagMaps(mergeMentionTagMaps(FAMILY_TAGS, memberCache?.byTag || {}), dynamicTags);

  if (Object.keys(allTags).length === 0) return text;

  const existingReplyTags = extractMentionTagsFromText(text, allTags);
  const existingSet = new Set(existingReplyTags);
  const tagsToPrepend = [];

  const speakerTag = findPreferredTagByUserId(speakerUserId, allTags);
  if (speakerTag && !existingSet.has(speakerTag)) { tagsToPrepend.push(speakerTag); existingSet.add(speakerTag); }

  for (const tag of extractMentionTagsFromText(userMsg, allTags)) {
    if (!existingSet.has(tag)) { tagsToPrepend.push(tag); existingSet.add(tag); }
  }
  for (const tag of extractKinshipTagsFromText(userMsg, kinshipToTag, FAMILY_TAGS)) {
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

// 監聽 Cloud Run 分配的連接埠
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`LINE Bot server running on port ${port}`);
});