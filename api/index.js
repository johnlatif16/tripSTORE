const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const cors = require("cors");
const app = express();

// ====== Middlewares ======
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.resolve(__dirname, "../public")));

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/login.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/dashboard.html"));
});

// ====== Multer ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

// ====== Cloudinary Config ======
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ====== Firebase Admin Init ======
function initFirebase() {
  if (admin.apps.length) return;

  if (!process.env.FIREBASE_CONFIG) {
    throw new Error("Missing FIREBASE_CONFIG env var");
  }
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("Missing FIREBASE_STORAGE_BUCKET env var");
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
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

// ====== Email ======
const transporter = nodemailer.createTransport({
  service: process.env.SMTP_SERVICE || "gmail",
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS
  }
});

// ====== Telegram Notify ======
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

// ====== Auth Helpers ======
function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.admin_token ||
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);

    if (!token) return res.status(403).json({ success: false, message: "غير مصرح" });

    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(403).json({ success: false, message: "غير مصرح" });
  }
}

function setAdminCookie(res, token) {
  res.cookie("admin_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

// ====== Storage Upload ======
async function uploadToCloudinary(file) {
  if (!file) return null;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "orders", resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(file.buffer);
  });
}

// ====== Health ======
app.get("/api/health", (req, res) => {
  res.json({ success: true, time: nowISO() });
});

// ====== Public APIs ======
app.post("/api/order", upload.single("screenshot"), async (req, res) => {
  try {
    const { name, playerId, email, ucAmount, bundle, totalAmount, transactionId, couponCode, discountAmount } = req.body;

    if (!name || !playerId || !email || !totalAmount || (!ucAmount && !bundle)) {
      return res.status(400).json({ success: false, message: "جميع الحقول الأساسية مطلوبة" });
    }

    const type = ucAmount ? "UC" : "Bundle";
    let screenshotUrl = null;

    if (req.file) {
      try {
        screenshotUrl = await uploadToCloudinary(req.file);
      } catch (uploadErr) {
        console.error("Upload error:", uploadErr);
      }
    }

    const orderData = {
      name, playerId, email, type,
      ucAmount: ucAmount || null,
      bundle: bundle || null,
      totalAmount: Number(totalAmount),
      transactionId: transactionId || null,
      screenshotUrl: screenshotUrl,
      status: "لم يتم الدفع",
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      couponCode: couponCode || null,
      discountAmount: discountAmount ? Number(discountAmount) : null
    };

    const ref = await firestore().collection("orders").add(orderData);

    telegramNotify(`🧾 طلب جديد\nالاسم: ${name}\nالبريد: ${email}\nالنوع: ${type}\nالإجمالي: ${totalAmount}\nID: ${ref.id}`).catch(e => console.error(e));

    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      transporter.sendMail({
        from: `"Trip Store" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "طلب جديد",
        html: `<div dir="rtl"><h2>طلب جديد</h2><p><b>الاسم:</b> ${name}</p><p><b>البريد:</b> ${email}</p><p><b>النوع:</b> ${type}</p><p><b>الإجمالي:</b> ${totalAmount}</p>${screenshotUrl ? `<p><a href="${screenshotUrl}">صورة التحويل</a></p>` : ""}</div>`
      }).catch(e => console.error(e));
    }

    return res.status(200).json({ success: true, id: ref.id, message: "تم إنشاء الطلب بنجاح" });
  } catch (err) {
    console.error("Error in /api/order:", err);
    return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحفظ: " + (err.message || "خطأ غير معروف") });
  }
});

app.get("/api/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await firestore().collection("orders").doc(id).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: "الطلب غير موجود" });
    const data = doc.data();
    if (data.created_at && data.created_at.toDate) data.created_at = data.created_at.toDate().toISOString();
    res.json({ success: true, data: { id: doc.id, ...data } });
  } catch (err) {
    res.status(500).json({ success: false, message: "خطأ في جلب الطلب" });
  }
});

app.post("/api/order/confirm-payment", upload.single("screenshot"), async (req, res) => {
  try {
    const { orderId, transactionId } = req.body;
    if (!orderId || !transactionId) return res.status(400).json({ success: false, message: "رقم الطلب ورقم المعاملة مطلوبان" });

    let screenshotUrl = null;
    if (req.file) screenshotUrl = await uploadToCloudinary(req.file);

    const updateData = {
      transactionId,
      status: "تم الدفع - قيد المراجعة",
      payment_confirmed_at: admin.firestore.FieldValue.serverTimestamp()
    };
    if (screenshotUrl) updateData.screenshotUrl = screenshotUrl;

    await firestore().collection("orders").doc(orderId).update(updateData);
    const orderDoc = await firestore().collection("orders").doc(orderId).get();
    const orderData = orderDoc.data();
    await telegramNotify(`💰 تم تأكيد الدفع\nرقم الطلب: ${orderId}\nرقم المعاملة: ${transactionId}\nالمبلغ: ${orderData.totalAmount}\nالعميل: ${orderData.name}`);
    res.json({ success: true, message: "تم تأكيد الدفع بنجاح", screenshotUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "حدث خطأ: " + (err.message || "خطأ غير معروف") });
  }
});

app.post("/api/inquiry", async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).json({ success: false, message: "البريد والرسالة مطلوبان" });

    const ref = await firestore().collection("inquiries").add({
      email, message, status: "قيد الانتظار",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await telegramNotify(`📩 استفسار جديد\nالبريد: ${email}\nID: ${ref.id}\n\n${message}`);
    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      await transporter.sendMail({
        from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "استفسار جديد من العميل",
        html: `<div dir="rtl"><h2>استفسار جديد</h2><p><b>البريد:</b> ${email}</p><p>${message}</p></div>`
      });
    }
    return res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "فشل إرسال الاستفسار" });
  }
});

app.post("/api/suggestion", async (req, res) => {
  try {
    const { name, contact, message } = req.body;
    if (!name || !contact || !message) return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });

    const ref = await firestore().collection("suggestions").add({
      name, contact, message,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await telegramNotify(`💡 اقتراح جديد\nالاسم: ${name}\nتواصل: ${contact}\nID: ${ref.id}\n\n${message}`);
    const notifyTo = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
    if (notifyTo) {
      await transporter.sendMail({
        from: `"اقتراح جديد" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
        to: notifyTo,
        subject: "اقتراح جديد للموقع",
        html: `<div dir="rtl"><h2>اقتراح جديد</h2><p><b>الاسم:</b> ${name}</p><p><b>طريقة التواصل:</b> ${contact}</p><p>${message}</p></div>`
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
  if (!username || !password) return res.status(400).json({ success: false, message: "بيانات الدخول مطلوبة" });
  if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) return res.status(401).json({ success: false, message: "بيانات الدخول غير صحيحة" });

  const token = jwt.sign({ role: "admin", u: username }, process.env.ADMIN_JWT_SECRET, { expiresIn: "7d" });
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

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  try {
    const snap = await firestore().collection("messages").orderBy("sent_at", "desc").get();
    const messages = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "فشل جلب الرسائل" });
  }
});

app.post("/api/admin/update-status", requireAdmin, async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json({ success: false, message: "معرّف الطلب والحالة مطلوبان" });
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

app.delete("/api/admin/delete-message", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "معرّف الرسالة مطلوب" });
    await firestore().collection("messages").doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "فشل حذف الرسالة" });
  }
});

app.post("/api/admin/reply-inquiry", requireAdmin, async (req, res) => {
  try {
    const { inquiryId, email, message, reply } = req.body;
    if (!inquiryId || !email || !message || !reply) return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });

    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
      to: email,
      subject: "رد على استفسارك",
      html: `<div dir="rtl"><h2>شكراً لتواصلك معنا</h2><p><strong>استفسارك:</strong></p><p>${message}</p><h3>رد الفريق:</h3><p>${reply}</p><p>مع تحيات فريق الدعم</p></div>`
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
    if (!email || !subject || !message) return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });

    await firestore().collection("messages").add({
      to: email, subject, message,
      sent_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER || process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html: `<div dir="rtl"><h2>${subject}</h2><div>${String(message).replace(/\n/g, "<br>")}</div><hr><p>مع تحيات فريق الدعم</p></div>`
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة" });
  }
});

// ====== COUPONS SYSTEM ======
function getCouponsCollection() {
  return firestore().collection("coupons");
}

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const { code, discountPercent, description, expiresAt } = req.body;
    if (!code || !discountPercent) return res.status(400).json({ success: false, message: "كود الخصم ونسبة الخصم مطلوبان" });

    const existing = await getCouponsCollection().where("code", "==", code.toUpperCase()).get();
    if (!existing.empty) return res.status(400).json({ success: false, message: "هذا الكود موجود بالفعل" });

    const couponData = {
      code: code.toUpperCase(),
      discountPercent: Number(discountPercent),
      description: description || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expiresAt ? admin.firestore.Timestamp.fromDate(new Date(expiresAt)) : null,
      usedCount: 0,
      isActive: true
    };
    const ref = await getCouponsCollection().add(couponData);
    res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const snap = await getCouponsCollection().orderBy("createdAt", "desc").get();
    const coupons = snap.docs.map(doc => {
      const data = doc.data();
      let expiryDate = null;
      if (data.expiresAt && data.expiresAt.toDate) expiryDate = data.expiresAt.toDate().toISOString();
      return { id: doc.id, ...data, expiresAt: expiryDate };
    });
    res.json({ success: true, data: coupons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await getCouponsCollection().doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/verify-coupon", async (req, res) => {
  try {
    const { code, originalAmount } = req.body;
    if (!code || !originalAmount) return res.status(400).json({ success: false, message: "الكود والمبلغ مطلوبان" });

    const snap = await getCouponsCollection().where("code", "==", code.toUpperCase()).where("isActive", "==", true).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, message: "الكوبون غير صالح أو منتهي الصلاحية" });

    const couponDoc = snap.docs[0];
    const coupon = { id: couponDoc.id, ...couponDoc.data() };
    if (coupon.expiresAt && coupon.expiresAt.toDate && coupon.expiresAt.toDate() < new Date()) {
      return res.status(400).json({ success: false, message: "انتهت صلاحية الكوبون" });
    }

    const discount = (Number(originalAmount) * coupon.discountPercent) / 100;
    const newAmount = Number(originalAmount) - discount;
    res.json({ success: true, discount: discount.toFixed(2), newTotal: newAmount.toFixed(2), discountPercent: coupon.discountPercent, couponCode: coupon.code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/use-coupon", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false });
    const snap = await getCouponsCollection().where("code", "==", code.toUpperCase()).limit(1).get();
    if (!snap.empty) await snap.docs[0].ref.update({ usedCount: admin.firestore.FieldValue.increment(1) });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

module.exports = app;
