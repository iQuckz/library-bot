/**
 * =========================================================
 *  ربات تلگرامی کتابخانه — Cloudflare Worker (بدون Wrangler)
 * =========================================================
 * دیتابیس: D1 (بایند به عنوان DB)   — داده‌های دائمی: کتاب‌ها، ژانرها، کاربران، درخواست‌ها
 * KV     : (بایند به عنوان SESS)    — وضعیت موقتِ مکالمه (چند مرحله‌ای بودن ثبت/ویرایش/broadcast)
 *
 * Variables/Secrets لازم (در تنظیمات Worker > Settings > Variables):
 *   BOT_TOKEN            (Secret)  توکن ربات از BotFather
 *   WEBHOOK_SECRET        (Secret) یک رشته‌ی دلخواه و تصادفی برای امن‌سازی مسیر وبهوک
 *   ADMIN_IDS                      آیدی عددی ادمین‌ها با کاما جدا شده. مثال: 111111,222222
 *   FORCE_JOIN_CHANNELS             یوزرنیم کانال‌های عضویت اجباری با کاما جدا شده. مثال: @ch1,@ch2
 *   BOOKS_CHANNEL                  لینک یا یوزرنیم کانال کتاب‌ها. مثال: https://t.me/yourchannel
 *   BOT_USERNAME                   یوزرنیم ربات بدون @ . مثال: librarygreatbot
 * =========================================================
 */

const REACTIONS = ["👀", "🌚", "💘"]; // چشم / ماه / قلب‌تیرخورده — پیش‌فرض: انتخاب تصادفی

// ---------- ابزارهای عمومی ----------

function adminIds(env) {
  return (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function isAdmin(id, env) {
  return adminIds(env).includes(Number(id));
}

function forceJoinChannels(env) {
  return (env.FORCE_JOIN_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// فاصله‌ی ادیت لِوِنشتاین برای جستجوی فازی (تشخیص اشتباه تایپی)
function levenshtein(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, "") // حذف اعراب فارسی
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .trim();
}

// امتیازدهی فازی به یک کتاب بر اساس عبارت جستجو
function fuzzyScoreBook(book, q) {
  const query = normalize(q);
  const fields = [
    book.title_fa, book.title_en, book.author_fa, book.author_en,
    book.genre_fa, book.genre_en,
    ...(safeJson(book.aliases_fa)), ...(safeJson(book.aliases_en)),
  ].filter(Boolean).map(normalize);

  let best = Infinity;
  for (const f of fields) {
    if (!f) continue;
    if (f.includes(query)) return 0; // تطابق مستقیم زیررشته -> بهترین امتیاز
    // مقایسه‌ی کلمه‌به‌کلمه برای عبارات چندکلمه‌ای
    const dist = levenshtein(f.slice(0, query.length + 3), query);
    if (dist < best) best = dist;
  }
  return best;
}

function safeJson(s, fallback = []) {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// ---------- تماس با API تلگرام ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.log("TG API ERROR", method, JSON.stringify(data));
  return data;
}

// ---------- کیبوردها ----------

function mainMenuKeyboard(env, admin) {
  const rows = [
    [{ text: "🔍 راهنمای جستجوی کتاب", callback_data: "m:search" }],
    [
      { text: "📚 ژانر", callback_data: "m:genre" },
      { text: "✍️ نویسنده‌ها و آثار", callback_data: "m:author" },
    ],
    [
      { text: "📩 سفارش کتاب", callback_data: "m:order" },
      { text: "💬 گفتگو با ادمین", callback_data: "m:fb" },
    ],
  ];
  if (env.BOOKS_CHANNEL) {
    rows.push([{ text: "📢 کانال کتاب‌ها", url: env.BOOKS_CHANNEL }]);
  }
  if (admin) {
    rows.push([{ text: "🛠 پنل مدیریت", callback_data: "adm:menu" }]);
  }
  return { inline_keyboard: rows };
}

function backRow(target) {
  return [{ text: "⬅️ بازگشت", callback_data: target }];
}

// ---------- KV Session ----------

async function getSession(env, uid) {
  const raw = await env.SESS.get(`sess:${uid}`);
  return raw ? JSON.parse(raw) : null;
}
async function setSession(env, uid, obj) {
  await env.SESS.put(`sess:${uid}`, JSON.stringify(obj), { expirationTtl: 3600 });
}
async function clearSession(env, uid) {
  await env.SESS.delete(`sess:${uid}`);
}

// ---------- دیتابیس D1 ----------

async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username) VALUES (?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username`
  ).bind(from.id, from.username || null).run();
}

async function getAllBooks(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM books ORDER BY created_at DESC`).all();
  return results || [];
}

async function getBookById(env, id) {
  return await env.DB.prepare(`SELECT * FROM books WHERE id = ?`).bind(id).first();
}
async function getBookBySlug(env, slug) {
  return await env.DB.prepare(`SELECT * FROM books WHERE slug = ?`).bind(slug).first();
}

async function getGenres(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM genres ORDER BY name_fa`).all();
  return results || [];
}

async function getDistinctAuthors(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT author_fa FROM books ORDER BY author_fa`
  ).all();
  return (results || []).map((r) => r.author_fa);
}

async function getBooksByGenre(env, genreFa) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM books WHERE genre_fa = ? ORDER BY title_fa`
  ).bind(genreFa).all();
  return results || [];
}
async function getBooksByAuthor(env, authorFa) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM books WHERE author_fa = ? ORDER BY title_fa`
  ).bind(authorFa).all();
  return results || [];
}

async function searchBooksFuzzy(env, q, limit = 15) {
  const books = await getAllBooks(env);
  return books
    .map((b) => ({ b, score: fuzzyScoreBook(b, q) }))
    .filter((x) => x.score <= 3) // آستانه‌ی خطای تایپی مجاز
    .sort((x, y) => x.score - y.score)
    .slice(0, limit)
    .map((x) => x.b);
}

// ---------- عضویت اجباری ----------

async function checkForceJoin(env, userId) {
  const channels = forceJoinChannels(env);
  const missing = [];
  for (const ch of channels) {
    try {
      const r = await tg(env, "getChatMember", { chat_id: ch, user_id: userId });
      const status = r?.result?.status;
      if (!r.ok || ["left", "kicked"].includes(status)) missing.push(ch);
    } catch {
      missing.push(ch);
    }
  }
  return missing;
}

function forceJoinKeyboard(missing) {
  const rows = missing.map((ch) => [
    { text: `عضویت در ${ch}`, url: ch.startsWith("@") ? `https://t.me/${ch.slice(1)}` : ch },
  ]);
  rows.push([{ text: "✅ عضو شدم، ادامه بده", callback_data: "chk:join" }]);
  return { inline_keyboard: rows };
}

// ---------- ارسال کتاب (تامنیل + PDF) ----------

async function deliverBook(env, chatId, book) {
  if (book.thumb_file_id) {
    await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: book.thumb_file_id,
      caption: book.thumb_caption || `<b>${escapeHtml(book.title_fa)}</b>\n✍️ ${escapeHtml(book.author_fa)}`,
      parse_mode: "HTML",
    });
  }
  if (book.pdf_file_id) {
    await tg(env, "sendDocument", {
      chat_id: chatId,
      document: book.pdf_file_id,
      caption: book.pdf_caption || undefined,
      parse_mode: book.pdf_caption ? "HTML" : undefined,
    });
    await env.DB.prepare(`UPDATE books SET downloads = downloads + 1 WHERE id = ?`).bind(book.id).run();
  } else {
    await tg(env, "sendMessage", { chat_id: chatId, text: "فایل PDF این کتاب هنوز ثبت نشده است." });
  }
}

// ---------- ساخت لیست‌های دکمه‌ای ----------

function bookListKeyboard(books, backTarget) {
  const rows = books.map((b) => [{ text: `${b.title_fa} — ${b.author_fa}`, callback_data: `b:${b.id}` }]);
  rows.push(backRow(backTarget));
  return { inline_keyboard: rows };
}

// =========================================================
//                      هندلر پیام‌ها
// =========================================================

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const text = msg.text || "";

  // ---- /start (با یا بدون دیپ‌لینک) ----
  if (text.startsWith("/start")) {
    await upsertUser(env, msg.from);

    // ری‌اکشن روی پیام start
    const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    tg(env, "setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji }],
    }).catch(() => {});

    const parts = text.split(" ");
    const payload = parts[1];

    if (payload && payload.startsWith("book_")) {
      const key = payload.replace("book_", "");
      const book = /^\d+$/.test(key) ? await getBookById(env, Number(key)) : await getBookBySlug(env, key);
      if (!book) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "کتاب موردنظر یافت نشد." });
      } else {
        const missing = await checkForceJoin(env, uid);
        if (missing.length) {
          await setSession(env, uid, { step: "await_join", data: { bookId: book.id } });
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: "برای دریافت فایل، ابتدا در کانال(های) زیر عضو شوید:",
            reply_markup: forceJoinKeyboard(missing),
          });
        } else {
          await deliverBook(env, chatId, book);
        }
      }
      return;
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "به ربات کتابخانه خوش آمدید! 📚\nاز منوی زیر یکی از گزینه‌ها را انتخاب کنید:",
      reply_markup: mainMenuKeyboard(env, isAdmin(uid, env)),
    });
    return;
  }

  if (text === "/admin") {
    if (!isAdmin(uid, env)) return;
    await tg(env, "sendMessage", { chat_id: chatId, text: "پنل مدیریت:", reply_markup: adminMenuKeyboard() });
    return;
  }

  // ---- ادامه‌ی جریان‌های چندمرحله‌ای (Session) ----
  const session = await getSession(env, uid);
  if (session) {
    await handleSessionMessage(env, msg, session);
    return;
  }

  // پیام آزاد بدون session -> یادآوری منو
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "برای شروع /start را بفرستید یا از منوی قبلی استفاده کنید.",
  });
}

// ---------- مدیریت جریان‌های چندمرحله‌ای ----------

async function handleSessionMessage(env, msg, session) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const step = session.step;
  const data = session.data || {};

  // --- سفارش کتاب ---
  if (step === "order_wait_text") {
    await env.DB.prepare(
      `INSERT INTO book_requests (telegram_id, username, text) VALUES (?, ?, ?)`
    ).bind(uid, msg.from.username || null, msg.text || "").run();

    for (const adminId of adminIds(env)) {
      tg(env, "sendMessage", {
        chat_id: adminId,
        text: `📩 درخواست کتاب جدید از @${msg.from.username || uid}:\n${msg.text}`,
      }).catch(() => {});
    }
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: "درخواست شما برای ادمین‌ها ارسال شد. ممنون! ✅" });
    return;
  }

  // --- گفتگو با ادمین: دریافت متن، سپس تاییدیه ---
  if (step === "fb_wait_text") {
    await setSession(env, uid, { step: "fb_confirm", data: { text: msg.text } });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `آیا از ارسال این پیام برای ادمین مطمئن هستید؟\n\n«${msg.text}»`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ بله، ارسال کن", callback_data: "fb:send" },
          { text: "❌ انصراف", callback_data: "fb:cancel" },
        ]],
      },
    });
    return;
  }

  // --- Broadcast (فقط ادمین) ---
  if (step === "bc_wait_text" && isAdmin(uid, env)) {
    await setSession(env, uid, { step: "bc_confirm", data: { text: msg.text } });
    await tg(env, "sendMessage", { chat_id: chatId, text: "پیش‌نمایش پیام همگانی:" });
    await tg(env, "sendMessage", { chat_id: chatId, text: msg.text });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "ارسال برای همه‌ی کاربران؟",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ بله، ارسال همگانی", callback_data: "bc:send" },
          { text: "❌ انصراف", callback_data: "bc:cancel" },
        ]],
      },
    });
    return;
  }

  // --- ثبت کتاب جدید: مراحل متنی ---
  if (step && step.startsWith("add_") && isAdmin(uid, env)) {
    await handleAddBookStep(env, msg, step, data);
    return;
  }

  // --- ویرایش کتاب: انتظار مقدار جدید یک فیلد ---
  if (step === "edit_wait_value" && isAdmin(uid, env)) {
    const { bookId, field } = data;
    if (["thumb_file_id", "pdf_file_id"].includes(field)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "برای این فیلد باید عکس/فایل بفرستید نه متن." });
      return;
    }
    await env.DB.prepare(`UPDATE books SET ${field} = ? WHERE id = ?`).bind(msg.text, bookId).run();
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ بروزرسانی شد.", reply_markup: { inline_keyboard: [backRow(`adm:edit:${bookId}`)] } });
    return;
  }
  if (step === "edit_wait_photo" && isAdmin(uid, env) && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await env.DB.prepare(`UPDATE books SET thumb_file_id = ? WHERE id = ?`).bind(fileId, data.bookId).run();
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ تامنیل بروزرسانی شد." });
    return;
  }
  if (step === "edit_wait_pdf" && isAdmin(uid, env) && msg.document) {
    await env.DB.prepare(`UPDATE books SET pdf_file_id = ? WHERE id = ?`).bind(msg.document.file_id, data.bookId).run();
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ فایل PDF بروزرسانی شد." });
    return;
  }

  // --- مدیریت ژانرها ---
  if (step === "genre_add_wait" && isAdmin(uid, env)) {
    const [fa, en] = (msg.text || "").split("|").map((s) => (s || "").trim());
    await env.DB.prepare(`INSERT INTO genres (name_fa, name_en) VALUES (?, ?)`).bind(fa, en || null).run();
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: `✅ ژانر «${fa}» اضافه شد.` });
    return;
  }
}

// مراحل ثبت کتاب جدید
const ADD_STEPS = [
  "add_author_fa", "add_title_fa", "add_genre_fa",
  "add_author_en", "add_title_en", "add_genre_en",
  "add_alias_fa", "add_alias_en",
];
const ADD_PROMPTS = {
  add_author_fa: "نام نویسنده (فارسی) را بفرستید:",
  add_title_fa: "نام کتاب (فارسی) را بفرستید:",
  add_genre_fa: "ژانر (فارسی) را بفرستید:",
  add_author_en: "نام نویسنده (انگلیسی) را بفرستید:",
  add_title_en: "نام کتاب (انگلیسی) را بفرستید:",
  add_genre_en: "ژانر (انگلیسی) را بفرستید:",
  add_alias_fa: "حداکثر ۳ نام جایگزین فارسی را با کاما جدا کرده بفرستید (یا 'ندارد' بفرستید):",
  add_alias_en: "حداکثر ۳ نام جایگزین انگلیسی را با کاما جدا کرده بفرستید (یا 'ندارد' بفرستید):",
};

async function handleAddBookStep(env, msg, step, data) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const idx = ADD_STEPS.indexOf(step);
  const fieldMap = {
    add_author_fa: "author_fa", add_title_fa: "title_fa", add_genre_fa: "genre_fa",
    add_author_en: "author_en", add_title_en: "title_en", add_genre_en: "genre_en",
  };

  if (step === "add_alias_fa" || step === "add_alias_en") {
    const key = step === "add_alias_fa" ? "aliases_fa" : "aliases_en";
    const val = (msg.text || "").trim();
    data[key] = val.toLowerCase() === "ندارد" ? [] : val.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  } else {
    data[fieldMap[step]] = msg.text;
  }

  const nextIdx = idx + 1;
  if (nextIdx < ADD_STEPS.length) {
    await setSession(env, uid, { step: ADD_STEPS[nextIdx], data });
    await tg(env, "sendMessage", { chat_id: chatId, text: ADD_PROMPTS[ADD_STEPS[nextIdx]] });
    return;
  }

  // پایان مراحل متنی -> نمایش خلاصه و درخواست تایید
  await setSession(env, uid, { step: "add_confirm", data });
  const summary =
    `لطفاً اطلاعات را بررسی کنید:\n\n` +
    `👤 نویسنده (فا): ${data.author_fa}\n📖 عنوان (فا): ${data.title_fa}\n🏷 ژانر (فا): ${data.genre_fa}\n` +
    `👤 نویسنده (en): ${data.author_en}\n📖 عنوان (en): ${data.title_en}\n🏷 ژانر (en): ${data.genre_en}\n` +
    `🔁 مستعار فا: ${(data.aliases_fa || []).join(", ") || "—"}\n🔁 مستعار en: ${(data.aliases_en || []).join(", ") || "—"}`;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: summary,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ تایید و ادامه", callback_data: "add:confirm" },
        { text: "❌ لغو", callback_data: "add:cancel" },
      ]],
    },
  });
}

// =========================================================
//                    هندلر Callback Query
// =========================================================

async function handleCallbackQuery(env, cq) {
  const uid = cq.from.id;
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const dataStr = cq.data || "";
  const admin = isAdmin(uid, env);

  const answer = () => tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const edit = (text, reply_markup) =>
    tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup, parse_mode: "HTML" });

  // ---- منوی اصلی ----
  if (dataStr === "m:back") {
    await edit("منوی اصلی:", mainMenuKeyboard(env, admin));
    return answer();
  }
  if (dataStr === "m:search") {
    await edit(
      `برای جستجوی کتاب، در هر چتی (حتی همین‌جا) این را تایپ کنید:\n<code>@${env.BOT_USERNAME} نام کتاب یا نویسنده یا ژانر</code>\n\nجستجو خطاهای تایپی جزئی را هم تشخیص می‌دهد.`,
      { inline_keyboard: [backRow("m:back")] }
    );
    return answer();
  }
  if (dataStr === "m:genre") {
    const genres = await getGenres(env);
    if (!genres.length) {
      await edit("هنوز ژانری ثبت نشده است.", { inline_keyboard: [backRow("m:back")] });
      return answer();
    }
    const rows = genres.map((g) => [{ text: g.name_fa, callback_data: `g:${g.id}` }]);
    rows.push(backRow("m:back"));
    await edit("یک ژانر را انتخاب کنید:", { inline_keyboard: rows });
    return answer();
  }
  if (dataStr === "m:author") {
    const authors = await getDistinctAuthors(env);
    if (!authors.length) {
      await edit("هنوز نویسنده‌ای ثبت نشده است.", { inline_keyboard: [backRow("m:back")] });
      return answer();
    }
    const rows = authors.map((a, i) => [{ text: a, callback_data: `a:${i}` }]);
    rows.push(backRow("m:back"));
    await env.SESS.put(`authorlist:${uid}`, JSON.stringify(authors), { expirationTtl: 600 });
    await edit("یک نویسنده را انتخاب کنید:", { inline_keyboard: rows });
    return answer();
  }
  if (dataStr === "m:order") {
    await setSession(env, uid, { step: "order_wait_text" });
    await edit("نام کتابی که پیدا نمی‌کنید را بفرستید تا برای ادمین ارسال شود:", { inline_keyboard: [backRow("m:back")] });
    return answer();
  }
  if (dataStr === "m:fb") {
    await setSession(env, uid, { step: "fb_wait_text" });
    await edit("پیام خود را برای ادمین بنویسید:", { inline_keyboard: [backRow("m:back")] });
    return answer();
  }

  // ---- عضویت اجباری ----
  if (dataStr === "chk:join") {
    const session = await getSession(env, uid);
    const missing = await checkForceJoin(env, uid);
    if (missing.length) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "هنوز در همه‌ی کانال‌ها عضو نیستید.", show_alert: true });
      return;
    }
    if (session?.data?.bookId) {
      const book = await getBookById(env, session.data.bookId);
      await clearSession(env, uid);
      if (book) await deliverBook(env, chatId, book);
    }
    return answer();
  }

  // ---- ژانر -> لیست کتاب ----
  if (dataStr.startsWith("g:")) {
    const genreId = dataStr.split(":")[1];
    const g = await env.DB.prepare(`SELECT * FROM genres WHERE id = ?`).bind(genreId).first();
    if (!g) return answer();
    const books = await getBooksByGenre(env, g.name_fa);
    if (!books.length) {
      await edit(`کتابی در ژانر «${g.name_fa}» ثبت نشده.`, { inline_keyboard: [backRow("m:genre")] });
      return answer();
    }
    await edit(`کتاب‌های ژانر «${g.name_fa}»:`, bookListKeyboard(books, "m:genre"));
    return answer();
  }

  // ---- نویسنده -> لیست کتاب ----
  if (dataStr.startsWith("a:")) {
    const idx = Number(dataStr.split(":")[1]);
    const raw = await env.SESS.get(`authorlist:${uid}`);
    const authors = raw ? JSON.parse(raw) : [];
    const authorName = authors[idx];
    if (!authorName) return answer();
    const books = await getBooksByAuthor(env, authorName);
    await edit(`آثار «${authorName}»:`, bookListKeyboard(books, "m:author"));
    return answer();
  }

  // ---- تحویل کتاب با بررسی عضویت اجباری ----
  if (dataStr.startsWith("b:")) {
    const bookId = Number(dataStr.split(":")[1]);
    const book = await getBookById(env, bookId);
    if (!book) return answer();
    const missing = await checkForceJoin(env, uid);
    if (missing.length) {
      await setSession(env, uid, { step: "await_join", data: { bookId } });
      await tg(env, "sendMessage", { chat_id: chatId, text: "برای دریافت فایل، ابتدا عضو کانال(های) زیر شوید:", reply_markup: forceJoinKeyboard(missing) });
      return answer();
    }
    await deliverBook(env, chatId, book);
    return answer();
  }

  // ---- گفتگو با ادمین: تایید/لغو ----
  if (dataStr === "fb:send") {
    const session = await getSession(env, uid);
    const text = session?.data?.text || "";
    await env.DB.prepare(`INSERT INTO feedback (telegram_id, username, message) VALUES (?, ?, ?)`)
      .bind(uid, cq.from.username || null, text).run();
    for (const adminId of adminIds(env)) {
      tg(env, "sendMessage", { chat_id: adminId, text: `💬 پیام جدید از @${cq.from.username || uid}:\n${text}` }).catch(() => {});
    }
    await clearSession(env, uid);
    await edit("پیام شما ارسال شد. سپاس! ✅", { inline_keyboard: [backRow("m:back")] });
    return answer();
  }
  if (dataStr === "fb:cancel") {
    await clearSession(env, uid);
    await edit("لغو شد.", { inline_keyboard: [backRow("m:back")] });
    return answer();
  }

  // ---- ادمین ----
  if (dataStr.startsWith("adm:") || dataStr.startsWith("add:") || dataStr.startsWith("bc:") || dataStr.startsWith("edit:")) {
    if (!admin) return answer();
    await handleAdminCallback(env, cq, dataStr, edit, answer);
    return;
  }

  return answer();
}

// ---------- پنل مدیریت ----------

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ ثبت کتاب جدید", callback_data: "adm:addbook" }],
      [{ text: "✏️ ویرایش کتاب", callback_data: "adm:editlist" }],
      [{ text: "🏷 مدیریت ژانرها", callback_data: "adm:genres" }],
      [{ text: "📢 پیام همگانی", callback_data: "adm:bc" }],
      [{ text: "📊 آمار", callback_data: "adm:stats" }],
      backRow("m:back"),
    ],
  };
}

async function handleAdminCallback(env, cq, dataStr, edit, answer) {
  const uid = cq.from.id;
  const chatId = cq.message.chat.id;

  if (dataStr === "adm:menu") {
    await edit("پنل مدیریت:", adminMenuKeyboard());
    return answer();
  }

  if (dataStr === "adm:addbook") {
    await setSession(env, uid, { step: "add_author_fa", data: {} });
    await edit(ADD_PROMPTS.add_author_fa, { inline_keyboard: [backRow("adm:menu")] });
    return answer();
  }

  if (dataStr === "add:confirm") {
    const session = await getSession(env, uid);
    await setSession(env, uid, { step: "add_wait_photo", data: session.data });
    await edit("عالی! حالا تصویر تامنیل (نسبت مربع) را همراه با کپشن دلخواه ارسال کنید:", { inline_keyboard: [backRow("adm:menu")] });
    return answer();
  }
  if (dataStr === "add:cancel") {
    await clearSession(env, uid);
    await edit("ثبت کتاب لغو شد.", adminMenuKeyboard());
    return answer();
  }

  if (dataStr === "adm:editlist") {
    const books = await getAllBooks(env);
    if (!books.length) {
      await edit("هنوز کتابی ثبت نشده.", { inline_keyboard: [backRow("adm:menu")] });
      return answer();
    }
    const rows = books.map((b) => [{ text: `${b.title_fa} — ${b.author_fa}`, callback_data: `adm:edit:${b.id}` }]);
    rows.push(backRow("adm:menu"));
    await edit("کتابی که می‌خواهید ویرایش کنید را انتخاب کنید:", { inline_keyboard: rows });
    return answer();
  }

  if (dataStr.startsWith("adm:edit:")) {
    const bookId = dataStr.split(":")[2];
    await edit("کدام فیلد را ویرایش می‌کنید؟", {
      inline_keyboard: [
        [{ text: "عنوان (فا)", callback_data: `edit:title_fa:${bookId}` }, { text: "نویسنده (فا)", callback_data: `edit:author_fa:${bookId}` }],
        [{ text: "ژانر (فا)", callback_data: `edit:genre_fa:${bookId}` }, { text: "عنوان (en)", callback_data: `edit:title_en:${bookId}` }],
        [{ text: "نویسنده (en)", callback_data: `edit:author_en:${bookId}` }, { text: "ژانر (en)", callback_data: `edit:genre_en:${bookId}` }],
        [{ text: "لینک اختصاصی (slug)", callback_data: `edit:slug:${bookId}` }],
        [{ text: "تامنیل (عکس جدید)", callback_data: `edit:thumb_file_id:${bookId}` }],
        [{ text: "فایل PDF جدید", callback_data: `edit:pdf_file_id:${bookId}` }],
        backRow("adm:editlist"),
      ],
    });
    return answer();
  }

  if (dataStr.startsWith("edit:")) {
    const [, field, bookId] = dataStr.split(":");
    if (field === "thumb_file_id") {
      await setSession(env, uid, { step: "edit_wait_photo", data: { bookId } });
      await edit("عکس جدید تامنیل را ارسال کنید:", { inline_keyboard: [backRow(`adm:edit:${bookId}`)] });
    } else if (field === "pdf_file_id") {
      await setSession(env, uid, { step: "edit_wait_pdf", data: { bookId } });
      await edit("فایل PDF جدید را ارسال کنید:", { inline_keyboard: [backRow(`adm:edit:${bookId}`)] });
    } else {
      await setSession(env, uid, { step: "edit_wait_value", data: { bookId, field } });
      await edit("مقدار جدید را بفرستید:", { inline_keyboard: [backRow(`adm:edit:${bookId}`)] });
    }
    return answer();
  }

  if (dataStr === "adm:genres") {
    const genres = await getGenres(env);
    const rows = genres.map((g) => [{ text: `${g.name_fa} ❌`, callback_data: `adm:gdel:${g.id}` }]);
    rows.push([{ text: "➕ افزودن ژانر", callback_data: "adm:gadd" }]);
    rows.push(backRow("adm:menu"));
    await edit("مدیریت ژانرها (برای حذف روی گزینه بزنید):", { inline_keyboard: rows });
    return answer();
  }
  if (dataStr === "adm:gadd") {
    await setSession(env, uid, { step: "genre_add_wait" });
    await edit("نام ژانر را به فرم «فارسی|English» بفرستید (مثال: تاریخی|Historical):", { inline_keyboard: [backRow("adm:genres")] });
    return answer();
  }
  if (dataStr.startsWith("adm:gdel:")) {
    const id = dataStr.split(":")[2];
    await env.DB.prepare(`DELETE FROM genres WHERE id = ?`).bind(id).run();
    await edit("حذف شد.", adminMenuKeyboard());
    return answer();
  }

  if (dataStr === "adm:bc") {
    await setSession(env, uid, { step: "bc_wait_text" });
    await edit("متن پیام همگانی را بفرستید:", { inline_keyboard: [backRow("adm:menu")] });
    return answer();
  }
  if (dataStr === "bc:cancel") {
    await clearSession(env, uid);
    await edit("لغو شد.", adminMenuKeyboard());
    return answer();
  }
  if (dataStr === "bc:send") {
    const session = await getSession(env, uid);
    const text = session?.data?.text || "";
    await clearSession(env, uid);
    const { results } = await env.DB.prepare(`SELECT telegram_id FROM users`).all();
    let sent = 0;
    for (const u of results || []) {
      try {
        await tg(env, "sendMessage", { chat_id: u.telegram_id, text });
        sent++;
      } catch {}
    }
    await edit(`✅ پیام برای ${sent} کاربر ارسال شد.`, adminMenuKeyboard());
    return answer();
  }

  if (dataStr === "adm:stats") {
    const totalUsers = (await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first())?.c || 0;
    const totalBooks = (await env.DB.prepare(`SELECT COUNT(*) c FROM books`).first())?.c || 0;
    const totalDownloads = (await env.DB.prepare(`SELECT SUM(downloads) c FROM books`).first())?.c || 0;
    const top = await env.DB.prepare(`SELECT title_fa, downloads FROM books ORDER BY downloads DESC LIMIT 5`).all();
    const topText = (top.results || []).map((b, i) => `${i + 1}. ${b.title_fa} — ${b.downloads} دانلود`).join("\n") || "—";
    const byGenre = await env.DB.prepare(`SELECT genre_fa, COUNT(*) c FROM books GROUP BY genre_fa`).all();
    const genreText = (byGenre.results || []).map((g) => `${g.genre_fa || "—"}: ${g.c}`).join("\n") || "—";

    await edit(
      `📊 آمار کلی\n\n👥 کاربران: ${totalUsers}\n📚 کتاب‌ها: ${totalBooks}\n⬇️ مجموع دانلودها: ${totalDownloads}\n\n🏆 پرطرفدارترین‌ها:\n${topText}\n\n📁 تعداد کتاب به تفکیک ژانر:\n${genreText}`,
      { inline_keyboard: [backRow("adm:menu")] }
    );
    return answer();
  }

  return answer();
}

// ---------- تکمیل ثبت کتاب با عکس/PDF ----------

async function handleAddBookMedia(env, msg) {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const session = await getSession(env, uid);
  if (!session) return false;

  if (session.step === "add_wait_photo" && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    session.data.thumb_file_id = fileId;
    session.data.thumb_caption = msg.caption || null;
    await setSession(env, uid, { step: "add_wait_pdf", data: session.data });
    await tg(env, "sendMessage", { chat_id: chatId, text: "حالا فایل PDF کتاب را ارسال کنید (کپشن اختیاری):" });
    return true;
  }

  if (session.step === "add_wait_pdf" && msg.document) {
    const d = session.data;
    await env.DB.prepare(
      `INSERT INTO books (author_fa, title_fa, genre_fa, author_en, title_en, genre_en, aliases_fa, aliases_en, thumb_file_id, thumb_caption, pdf_file_id, pdf_caption)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      d.author_fa, d.title_fa, d.genre_fa, d.author_en, d.title_en, d.genre_en,
      JSON.stringify(d.aliases_fa || []), JSON.stringify(d.aliases_en || []),
      d.thumb_file_id, d.thumb_caption, msg.document.file_id, msg.caption || null
    ).run();
    await clearSession(env, uid);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ کتاب با موفقیت ثبت شد.", reply_markup: adminMenuKeyboard() });
    return true;
  }

  return false;
}

// =========================================================
//                    هندلر Inline Query
// =========================================================

async function handleInlineQuery(env, iq) {
  const q = (iq.query || "").trim();
  let results = [];

  if (!q) {
    const results_empty = [{
      type: "article",
      id: "help",
      title: "برای جستجو نام کتاب، نویسنده یا ژانر را تایپ کنید",
      input_message_content: { message_text: `از منوی اصلی ربات @${env.BOT_USERNAME} استفاده کنید.` },
    }];
    await tg(env, "answerInlineQuery", { inline_query_id: iq.id, results: results_empty, cache_time: 5 });
    return;
  }

  const books = await searchBooksFuzzy(env, q, 20);

  results = books
    .filter((b) => b.pdf_file_id)
    .map((b) => ({
      type: "document",
      id: `bk${b.id}`,
      title: b.title_fa,
      description: `✍️ ${b.author_fa} | 🏷 ${b.genre_fa || "—"}`,
      document_file_id: b.pdf_file_id,
      caption: b.pdf_caption || `<b>${escapeHtml(b.title_fa)}</b>\n✍️ ${escapeHtml(b.author_fa)}`,
      parse_mode: "HTML",
    }));

  await tg(env, "answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 5, is_personal: true });
}

// =========================================================
//                      ورودی Worker
// =========================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Library bot worker is running.");
    }

    // مسیر امن وبهوک: /webhook/<WEBHOOK_SECRET>
    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }

      ctx.waitUntil(processUpdate(env, update));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};

async function processUpdate(env, update) {
  try {
    if (update.message) {
      const msg = update.message;
      // اگر در جریان ثبت کتاب منتظر عکس/PDF هستیم
      const handledMedia = (msg.photo || msg.document) && (await handleAddBookMedia(env, msg));
      if (handledMedia) return;
      await handleMessage(env, msg);
      return;
    }
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return;
    }
    if (update.inline_query) {
      await handleInlineQuery(env, update.inline_query);
      return;
    }
  } catch (e) {
    console.log("ERROR processing update:", e.message, e.stack);
  }
}
