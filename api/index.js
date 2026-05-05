const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

const app = express();

// ====== Middlewares ======
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ====== Multer memory (serverless-safe) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

// ====== Firebase Admin Init ======
function initFirebase() {
  if (admin.apps.length) return;

  if (!process.env.FIREBASE_CONFIG) {
    throw new Error("Missing FIREBASE_CONFIG env var (service account JSON).");
  }
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("Missing FIREBASE_STORAGE_BUCKET env var.");
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

  // fix \n in private key when stored in env
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

function firestore() {
  initFirebase();
  return admin.firestore();
}

function storageBucket() {
  initFirebase();
  return admin.storage().bucket();
}

function nowISO() {
  return new Date().toISOString();
}

// ====== Email (Nodemailer) ======
const transporter = nodemailer.createTransport({
  service: process.env.SMTP_SERVICE || "gmail",
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS
  }
});

// ====== Telegram notify (no extra deps) ======
async function telegramNotify(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = new URLSearchParams({
      chat_id: String(chatId),
      text: String(text),
      parse_mode: "HTML"
    });

    await fetch(url, { method: "POST", body });
  } catch (e) {
    console.error("Telegram notify failed:", e?.message || e);
  }
}

// ====== Auth helpers ======
function requireAdmin(req, res, next) {
  try {
    const token =
      req.cookies?.admin_token ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);

    if (!token) return res.status(403).json({ success: false, message: "غير مصرح" });

    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(403).json({ success: false, message: "غير مصرح" });
  }
}

function setAdminCookie(res, token) {
  // لو موقعك على HTTPS (Vercel) خليه secure=true
  res.cookie("admin_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

// ====== Storage upload ======
async function uploadScreenshotToStorage(file) {
  if (!file) return null;

  const ext =
    (file.originalname && file.originalname.includes("."))
      ? file.originalname.split(".").pop()
      : "png";

  const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const filename = `orders/${Date.now()}-${Math.random().toString(16).slice(2)}.${safeExt}`;

  const b = storageBucket();
  const obj = b.file(filename);

  await obj.save(file.buffer, {
    contentType: file.mimetype || "application/octet-stream",
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" }
  });

  // Public URL (بديل: signed URL)
  await obj.makePublic();
  return `https://storage.googleapis.com/${b.name}/${filename}`;
}

// ====== Health ======
app.get("/api/health", (req, res) => {
  res.json({ success: true, time: nowISO() });
});

// ====== Public APIs ======
app.post("/api/order", upload.single("screenshot"), async (req, res) => {
  try {
    const { name, playerId, email, ucAmount, bundle, totalAmount, transactionId } = req.body;

    // التحقق من الحقول المطلوبة (transactionId أصبح غير مطلوب هنا)
    if (!name || !playerId || !email || !totalAmount || (!ucAmount && !bundle)) {
      return res.status(400).json({ success: false, message: "جميع الحقول الأساسية مطلوبة" });
    }

    const type = ucAmount ? "UC" : "Bundle";
    const screenshotUrl = await uploadScreenshotToStorage(req.file);

    const ref = await firestore().collection("orders").add({
      name,
      playerId,
      email,
      type,
      ucAmount: ucAmount || null,
      bundle: bundle || null,
      totalAmount,
      transactionId: transactionId || null, // إذا لم يتم إرساله يصبح null
      screenshotUrl: screenshotUrl || null,
      status: "لم يتم الدفع",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // إشعار تليجرام
    const note = `🧾 طلب جديد\nالاسم: ${name}\nالبريد: ${email}\nالنوع: ${type}\nالإجمالي: ${totalAmount}\nID: ${ref.id}`;
    await telegramNotify(note);

    // إشعار إيميل
    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      await transporter.sendMail({
        from: `"Trip Store" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "طلب جديد",
        html: `<div dir="rtl">
          <h2>طلب جديد</h2>
          <p><b>الاسم:</b> ${name}</p>
          <p><b>البريد:</b> ${email}</p>
          <p><b>النوع:</b> ${type}</p>
          <p><b>الإجمالي:</b> ${totalAmount}</p>
          ${screenshotUrl ? `<p><a href="${screenshotUrl}">صورة التحويل</a></p>` : ""}
          <p style="color:#999;font-size:12px;">ID: ${ref.id}</p>
        </div>`
      });
    }

    return res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحفظ" });
  }
});

app.post("/api/inquiry", async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) {
      return res.status(400).json({ success: false, message: "البريد والرسالة مطلوبان" });
    }

    const ref = await firestore().collection("inquiries").add({
      email,
      message,
      status: "قيد الانتظار",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await telegramNotify(`📩 استفسار جديد\nالبريد: ${email}\nID: ${ref.id}\n\n${message}`);

    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      await transporter.sendMail({
        from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "استفسار جديد من العميل",
        html: `<div dir="rtl">
          <h2 style="color:#ffa726;">استفسار جديد</h2>
          <p><b>البريد:</b> ${email}</p>
          <p style="background:#f5f5f5;padding:10px;border-right:3px solid #ffa726;">${message}</p>
          <p style="color:#999;font-size:12px;">ID: ${ref.id}</p>
        </div>`
      });
    }

    return res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "فشل إرسال البريد الإلكتروني" });
  }
});

app.post("/api/suggestion", async (req, res) => {
  try {
    const { name, contact, message } = req.body;
    if (!name || !contact || !message) {
      return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
    }

    const ref = await firestore().collection("suggestions").add({
      name,
      contact,
      message,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await telegramNotify(`💡 اقتراح جديد\nالاسم: ${name}\nتواصل: ${contact}\nID: ${ref.id}\n\n${message}`);

    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      await transporter.sendMail({
        from: `"اقتراح جديد" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "اقتراح جديد للموقع",
        html: `<div dir="rtl">
          <h2 style="color:#ffa726;">اقتراح جديد</h2>
          <p><b>الاسم:</b> ${name}</p>
          <p><b>طريقة التواصل:</b> ${contact}</p>
          <p style="background:#f5f5f5;padding:10px;border-right:3px solid #ffa726;">${message}</p>
          <p style="color:#999;font-size:12px;">ID: ${ref.id}</p>
        </div>`
      });
    }

    return res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "فشل إرسال الاقتراح" });
  }
});

// ====== Admin APIs ======
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: "بيانات الدخول مطلوبة" });
  }

  if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
    return res.status(401).json({ success: false, message: "بيانات الدخول غير صحيحة" });
  }

  const token = jwt.sign(
    { role: "admin", u: username },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );

  setAdminCookie(res, token);
  return res.json({ success: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.clearCookie("admin_token");
  res.json({ success: true });
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const snap = await firestore().collection("orders").orderBy("created_at", "desc").get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
  }
});

app.get("/api/admin/inquiries", requireAdmin, async (req, res) => {
  try {
    const snap = await firestore().collection("inquiries").orderBy("created_at", "desc").get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
  }
});

app.get("/api/admin/suggestions", requireAdmin, async (req, res) => {
  try {
    const snap = await firestore().collection("suggestions").orderBy("created_at", "desc").get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
  }
});

app.post("/api/admin/update-status", requireAdmin, async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) {
      return res.status(400).json({ success: false, message: "معرّف الطلب والحالة مطلوبان" });
    }

    await firestore().collection("orders").doc(id).update({ status });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "حدث خطأ أثناء التحديث" });
  }
});

app.delete("/api/admin/delete-order", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "معرّف الطلب مطلوب" });

    await firestore().collection("orders").doc(id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
  }
});

app.delete("/api/admin/delete-inquiry", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "معرّف الاستفسار مطلوب" });

    await firestore().collection("inquiries").doc(id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
  }
});

app.delete("/api/admin/delete-suggestion", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "معرّف الاقتراح مطلوب" });

    await firestore().collection("suggestions").doc(id).delete();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
  }
});

app.post("/api/admin/reply-inquiry", requireAdmin, async (req, res) => {
  try {
    const { inquiryId, email, message, reply } = req.body;
    if (!inquiryId || !email || !message || !reply) {
      return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
    }

    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
      to: email,
      subject: "رد على استفسارك",
      html: `<div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#ffa726;">شكراً لتواصلك معنا</h2>
        <p><strong>استفسارك:</strong></p>
        <p style="background:#f5f5f5;padding:10px;border-right:3px solid #ffa726;">${message}</p>
        <h3 style="color:#ffa726;">رد الفريق:</h3>
        <p style="background:#f5f5f5;padding:10px;border-right:3px solid #2196F3;">${reply}</p>
        <hr>
        <p style="text-align:center;color:#777;">مع تحيات فريق الدعم</p>
      </div>`
    });

    await firestore().collection("inquiries").doc(inquiryId).update({ status: "تم الرد" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "فشل إرسال الرد" });
  }
});

app.post("/api/admin/send-message", requireAdmin, async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    if (!email || !subject || !message) {
      return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
    }

    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html: `<div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#ffa726;">${subject}</h2>
        <div style="background:#f5f5f5;padding:15px;border-radius:5px;border-right:3px solid #2196F3;">
          ${String(message).replace(/\n/g, "<br>")}
        </div>
        <hr>
        <p style="text-align:center;color:#777;">مع تحيات فريق الدعم</p>
      </div>`
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة" });
  }
});

// ====== IMPORTANT for Vercel: export app (no listen) ======
module.exports = app;
