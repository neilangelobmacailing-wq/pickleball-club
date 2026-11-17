"use strict";

/* ==========================================================================
   Dink & Drive – backend server
   Express API + static file hosting. Data is stored in data/db.json.
   ========================================================================== */

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const reports = require("./reports");

// ---------------------------------------------------------------------------
// Configuration (override with environment variables)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const TZ = process.env.CLUB_TZ || "Asia/Manila";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const LOGO_FILE = path.join(DATA_DIR, "logo.bin");
const CLUB_NAME = process.env.CLUB_NAME || "Dink & Drive";
// Excel reports: data/reports/<YYYY-MM>/Daily-Report-<date>.xlsx
const REPORT_DIR = path.join(DATA_DIR, "reports");
const PENDING_DIR = path.join(DATA_DIR, "pending-reports"); // safety copy until the Excel file is written
const HISTORY_FILE = path.join(DATA_DIR, "revenue-history.json");
const HISTORY_XLSX = "Revenue-History.xlsx";
const SESSION_MS = 12 * 60 * 60 * 1000; // staff stay logged in for 12h of activity

const ACCOUNTS = {
  staff: {
    password: process.env.STAFF_PASSWORD || "1234",
    fullName: "Front Desk Staff",
  },
  admin: {
    password: process.env.ADMIN_PASSWORD || "admin123",
    fullName: "Club Manager (Admin)",
  },
};

// Club rules
// How far ahead a play date can be booked (override with BOOKING_DAYS_AHEAD)
const MAX_DAYS_AHEAD = Number(process.env.BOOKING_DAYS_AHEAD) || 365;
const COURT_IDS = ["Court 1", "Court 2", "Court 3", "Court 4"];
const OPEN_HOUR = 7;
const CLOSE_HOUR = 22;
const OFF_PEAK_RATE = 350;
const PEAK_RATE = 500;
const CATALOG = {
  paddle: { label: "Carbon Paddle Rental", price: 150, isRental: true },
  balls: { label: "3-Pack Outdoor Balls", price: 280, isRental: false },
  drink: { label: "Electrolyte Drink", price: 65, isRental: false },
  grip: { label: "Grip Tape", price: 120, isRental: false },
};
const CHANNELS = ["Walk-In", "Text / Chat"];
const PAID_METHODS = [
  "Pay at Counter - Cash",
  "GCash / Transfer Verified via Chat",
];
const UNPAID = "Unpaid / Pending Arrival";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const bad = (message, status = 400) => {
  throw new ApiError(message, status);
};

function todayIso() {
  // YYYY-MM-DD in the club's timezone (not the server's)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function currentHour() {
  // Current hour (0-23) in the club's timezone
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return Number(h) % 24;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function stampNow() {
  return new Date().toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtHour(hour) {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour > 12 ? hour - 12 : hour;
  return `${String(h).padStart(2, "0")}:00 ${period}`;
}

const rateFor = (hour) =>
  hour >= 17 && hour <= 20 ? PEAK_RATE : OFF_PEAK_RATE;

function cleanStr(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Storage (single JSON file, written atomically)
// ---------------------------------------------------------------------------
function defaultDb() {
  return {
    meta: {
      nextReservation: 101,
      nextLoan: 101,
      nextReceipt: 1001,
      nextSale: 1,
      posDay: todayIso(),
      posAmount: 0,
      logoVersion: 0,
      logoMime: null,
    },
    reservations: [],
    loans: [],
    posSales: [], // every counter sale (archived to Excel at end of day)
    roster: [
      {
        name: "Andrea Lim",
        role: "Front Desk & Chat",
        shift: "02PM–10PM",
        color: "#198754",
      },
      {
        name: "Jomar Tan",
        role: "Court Marshal",
        shift: "02PM–10PM",
        color: "#0d6efd",
      },
      {
        name: "Camille Santos",
        role: "Pro Shop",
        shift: "04PM–10PM",
        color: "#fd7e14",
      },
    ],
  };
}

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const base = defaultDb();
    return {
      meta: { ...base.meta, ...(parsed.meta || {}) },
      reservations: Array.isArray(parsed.reservations)
        ? parsed.reservations
        : [],
      loans: Array.isArray(parsed.loans) ? parsed.loans : [],
      posSales: Array.isArray(parsed.posSales) ? parsed.posSales : [],
      roster: Array.isArray(parsed.roster) ? parsed.roster : base.roster,
    };
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Could not read db.json, starting fresh:", err.message);
    return null;
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let db = loadDb();
if (!db) {
  db = defaultDb();
  if (process.env.SEED_DEMO === "1") seedDemo();
  saveDb();
}

function seedDemo() {
  const t = todayIso();
  const tomorrow = addDays(t, 1);
  const mk = (o) => {
    const n = db.meta.nextReservation++;
    return {
      id: `RES-${n}`,
      createdAt: new Date().toISOString(),
      processedBy: "Front Desk Staff",
      ...o,
    };
  };
  const paid = () => `OR-${new Date().getFullYear()}-${db.meta.nextReceipt++}`;
  db.reservations.push(
    mk({
      receiptNo: paid(),
      date: t,
      channel: "Walk-In",
      customer: "Bianca Soriano",
      contact: "0917-554-1920",
      court: "Court 1",
      startHour: 17,
      duration: 2,
      courtFee: 1000,
      addons: [{ label: "2x Carbon Paddle Rental", amount: 300 }],
      preferences: "Prefers extra court fan; beginner doubles session",
      total: 1300,
      paymentStatus: PAID_METHODS[0],
      isPaid: true,
      paidAt: stampNow(),
      status: "Checked-In",
    }),
    mk({
      receiptNo: paid(),
      date: t,
      channel: "Text / Chat",
      customer: "Rafael Mendoza",
      contact: "Viber: 0918-882-3411",
      court: "Court 2",
      startHour: 18,
      duration: 1,
      courtFee: 500,
      addons: [{ label: "1x 3-Pack Outdoor Balls", amount: 280 }],
      preferences: "Wants Court 2 near water station",
      total: 780,
      paymentStatus: PAID_METHODS[1],
      isPaid: true,
      paidAt: stampNow(),
      status: "Reserved",
    }),
    mk({
      receiptNo: null,
      date: t,
      channel: "Text / Chat",
      customer: "Katrina Velasco",
      contact: "Messenger: @katvelasco",
      court: "Court 3",
      startHour: 19,
      duration: 1,
      courtFee: 500,
      addons: [
        { label: "1x Carbon Paddle Rental", amount: 150 },
        { label: "2x Electrolyte Drink", amount: 130 },
      ],
      preferences: "Left-handed paddle grip requested",
      total: 780,
      paymentStatus: UNPAID,
      isPaid: false,
      paidAt: null,
      status: "Reserved",
    }),
    mk({
      receiptNo: paid(),
      date: tomorrow,
      channel: "Text / Chat",
      customer: "Denise Chua",
      contact: "SMS: 0917-332-1190",
      court: "Court 1",
      startHour: 18,
      duration: 2,
      courtFee: 1000,
      addons: [{ label: "1x Grip Tape", amount: 120 }],
      preferences: "Needs white overgrip installed before 6 PM",
      total: 1120,
      paymentStatus: PAID_METHODS[1],
      isPaid: true,
      paidAt: stampNow(),
      status: "Reserved",
    }),
  );
  db.loans.push({
    id: `LN-${db.meta.nextLoan++}`,
    item: "2x Carbon Paddle Rental",
    holder: "Bianca Soriano (Court 1)",
    returned: false,
    returnedDay: null,
  });
  console.log("Demo data loaded (SEED_DEMO=1).");
}

// ---------------------------------------------------------------------------
// End-of-day: archive yesterday to Excel, then start fresh
// ---------------------------------------------------------------------------
const reportCfg = () => ({
  clubName: CLUB_NAME,
  courtIds: COURT_IDS,
  openHour: OPEN_HOUR,
  closeHour: CLOSE_HOUR,
  cashMethod: PAID_METHODS[0],
  gcashMethod: PAID_METHODS[1],
});

function reportPathFor(date) {
  // data/reports/2026-11/Daily-Report-2026-11-16.xlsx (never overwrites an older file)
  const dir = path.join(REPORT_DIR, date.slice(0, 7));
  let name = `Daily-Report-${date}.xlsx`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++)
    name = `Daily-Report-${date}-v${n}.xlsx`;
  return path.join(date.slice(0, 7), name).replace(/\\/g, "/");
}

// Copy every record that belongs to a finished day into a safety file,
// then remove those records from the live database.
function archivePastDays(today) {
  const dates = new Set();
  for (const r of db.reservations) if (r.date < today) dates.add(r.date);
  for (const x of db.posSales) if (x.day < today) dates.add(x.day);

  // Older installs only kept a counter-sales TOTAL (no item list)
  const legacy =
    db.meta.posDay < today
      ? Math.max(
          0,
          db.meta.posAmount -
            db.posSales
              .filter((x) => x.day === db.meta.posDay)
              .reduce((t, x) => t + x.price, 0),
        )
      : 0;
  if (legacy > 0) dates.add(db.meta.posDay);

  if (dates.size === 0) return;
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  for (const date of [...dates].sort()) {
    const snap = {
      date,
      generatedAt: stampNow(),
      reservations: db.reservations.filter((r) => r.date === date),
      posSales: db.posSales.filter((x) => x.day === date),
      loans: db.loans.filter(
        (l) => l.createdDay === date || l.returnedDay === date,
      ),
      outFile: reportPathFor(date),
    };
    if (legacy > 0 && date === db.meta.posDay)
      snap.posSales.push({
        id: "OLD",
        day: date,
        time: "",
        item: "Counter sales (total only – not itemized)",
        price: legacy,
      });
    fs.writeFileSync(
      path.join(PENDING_DIR, `${date}-${Date.now()}.json`),
      JSON.stringify(snap, null, 2),
    );
  }

  // Safety copies are on disk – now clear the finished days from the live data
  db.reservations = db.reservations.filter((r) => r.date >= today);
  db.posSales = db.posSales.filter((x) => x.day >= today);
}

// New day: archive, reset counter sales, drop loans returned on an earlier day
function rollDay() {
  const today = todayIso();
  const stale =
    db.meta.posDay !== today ||
    db.reservations.some((r) => r.date < today) ||
    db.posSales.some((x) => x.day < today);
  if (!stale) return today;

  archivePastDays(today);
  if (db.meta.posDay !== today) {
    db.meta.posDay = today;
    db.meta.posAmount = 0;
    db.loans = db.loans.filter((l) => !l.returned || l.returnedDay === today);
  }
  saveDb();
  processPendingReports();
  return today;
}

// ---------------------------------------------------------------------------
// Excel files
// ---------------------------------------------------------------------------
let processing = false;
let historyDirty = fs.existsSync(HISTORY_FILE);

function readHistory() {
  try {
    const rows = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    return [];
  }
}

async function writeWorkbook(wb, relFile) {
  const full = path.join(REPORT_DIR, relFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, full);
  return full;
}

function hasPending() {
  try {
    return fs.readdirSync(PENDING_DIR).some((f) => f.endsWith(".json"));
  } catch (err) {
    return false;
  }
}

async function processPendingReports() {
  if (processing) return;
  processing = true;
  try {
    let files = [];
    try {
      files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch (err) {
      /* nothing pending */
    }
    for (const f of files) {
      const full = path.join(PENDING_DIR, f);
      try {
        const snap = JSON.parse(fs.readFileSync(full, "utf8"));
        const cfg = reportCfg();
        const wb = await reports.buildDailyWorkbook(snap, cfg);
        await writeWorkbook(wb, snap.outFile);

        const rows = readHistory().filter((r) => r.date !== snap.date);
        rows.push(reports.historyRow(snap, cfg, snap.outFile));
        rows.sort((a, b) => a.date.localeCompare(b.date));
        fs.writeFileSync(`${HISTORY_FILE}.tmp`, JSON.stringify(rows, null, 2));
        fs.renameSync(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
        historyDirty = true;

        fs.unlinkSync(full);
        console.log(`Daily report saved: reports/${snap.outFile}`);
      } catch (err) {
        // Kept in pending-reports/ and retried automatically
        console.error(`Could not write report from ${f}: ${err.message}`);
      }
    }
    if (historyDirty) {
      try {
        const wb = await reports.buildHistoryWorkbook(readHistory(), reportCfg());
        await writeWorkbook(wb, HISTORY_XLSX);
        historyDirty = false;
      } catch (err) {
        console.error(`Could not update ${HISTORY_XLSX}: ${err.message}`);
      }
    }
  } finally {
    processing = false;
  }
}

function isOccupied(date, court, hour) {
  return db.reservations.some(
    (r) =>
      r.date === date &&
      r.court === court &&
      r.status !== "Cancelled" &&
      r.status !== "Completed" &&
      hour >= r.startHour &&
      hour < r.startHour + r.duration,
  );
}

function findReservation(id) {
  return (
    db.reservations.find((r) => r.id === id) ||
    bad("Reservation not found.", 404)
  );
}

function createLoan(item, holder) {
  const loan = {
    id: `LN-${db.meta.nextLoan++}`,
    item,
    holder,
    returned: false,
    returnedDay: null,
    createdDay: todayIso(),
  };
  db.loans.unshift(loan);
  return loan;
}

function nextReceiptNo() {
  return `OR-${new Date().getFullYear()}-${db.meta.nextReceipt++}`;
}

// ---------------------------------------------------------------------------
// Sessions (in memory – staff log in again after a server restart)
// ---------------------------------------------------------------------------
const sessions = new Map();
const loginAttempts = new Map();

function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Please log in again." });
  }
  session.expires = Date.now() + SESSION_MS;
  req.session = session;
  next();
}

// ---------------------------------------------------------------------------
// App & routes
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
const jsonSmall = express.json({ limit: "100kb" });
const jsonLogo = express.json({ limit: "3mb" });

app.use("/api", (req, res, next) => {
  req.today = rollDay();
  res.set("Cache-Control", "no-store");
  next();
});

// ----- Auth -----
app.post("/api/login", jsonSmall, (req, res) => {
  const now = Date.now();
  const rec = loginAttempts.get(req.ip);
  if (rec && rec.resetAt > now && rec.count >= 10) {
    bad("Too many failed attempts. Please wait 15 minutes.", 429);
  }

  const username = cleanStr(req.body?.username, 40).toLowerCase();
  const password = String(req.body?.password ?? "");
  const account = Object.prototype.hasOwnProperty.call(ACCOUNTS, username)
    ? ACCOUNTS[username]
    : null;

  if (!account || !safeEqual(account.password, password)) {
    const fresh =
      rec && rec.resetAt > now
        ? rec
        : { count: 0, resetAt: now + 15 * 60 * 1000 };
    fresh.count += 1;
    loginAttempts.set(req.ip, fresh);
    bad("Invalid username or password/PIN.", 401);
  }

  loginAttempts.delete(req.ip);
  const staffName = cleanStr(req.body?.staffName, 60) || account.fullName;
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, staffName, expires: now + SESSION_MS });
  res.json({ token, staffName });
});

app.post("/api/logout", requireAuth, (req, res) => {
  sessions.delete((req.get("authorization") || "").slice(7));
  res.json({ ok: true });
});

// ----- Public board (no customer details – only which slots are taken) -----
app.get("/api/board", (req, res) => {
  // A reservation shows as taken only until its session ends: either staff
  // press Complete, or the end time passes (club timezone).
  const nowHour = currentHour();
  const board = db.reservations
    .filter(
      (r) =>
        r.date >= req.today &&
        r.status !== "Cancelled" &&
        r.status !== "Completed" &&
        !(r.date === req.today && r.startHour + r.duration <= nowHour),
    )
    .map((r) => ({
      date: r.date,
      court: r.court,
      startHour: r.startHour,
      duration: r.duration,
    }));
  res.json({
    today: req.today,
    maxDate: addDays(req.today, MAX_DAYS_AHEAD),
    board,
    hasLogo: Boolean(db.meta.logoMime),
    logoVersion: db.meta.logoVersion,
  });
});

// ----- Staff data -----
app.get("/api/data", requireAuth, (req, res) => {
  res.json({
    today: req.today,
    reservations: db.reservations.filter(
      (r) => r.date >= req.today && r.status !== "Cancelled",
    ),
    loans: db.loans,
    posExtraRevenue: db.meta.posDay === req.today ? db.meta.posAmount : 0,
    roster: db.roster,
  });
});

// ----- Reservations -----
app.post("/api/reservations", requireAuth, jsonSmall, (req, res) => {
  const b = req.body || {};

  const channel = CHANNELS.includes(b.channel)
    ? b.channel
    : bad("Invalid booking channel.");
  const customer = cleanStr(b.customer, 80);
  const contact = cleanStr(b.contact, 80);
  if (!customer || !contact)
    bad("Customer name and phone/chat handle are required.");

  const date = String(b.date || "");
  const realDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
  if (!realDate) bad("Invalid play date.");
  if (date < req.today) bad("That date has already passed.");
  if (date > addDays(req.today, MAX_DAYS_AHEAD))
    bad(`Bookings can only be made up to ${MAX_DAYS_AHEAD} days ahead.`);

  const court = COURT_IDS.includes(b.court) ? b.court : bad("Invalid court.");
  const startHour = Number(b.startHour);
  const duration = Number(b.duration);
  if (
    !Number.isInteger(startHour) ||
    startHour < OPEN_HOUR ||
    startHour >= CLOSE_HOUR
  )
    bad("Invalid start time.");
  if (!Number.isInteger(duration) || duration < 1 || duration > 3)
    bad("Duration must be 1 to 3 hours.");
  if (startHour + duration > CLOSE_HOUR)
    bad("Session exceeds 10:00 PM club closing time.");
  if (date === req.today && startHour + duration <= currentHour())
    bad("That time has already passed. Please choose a later time.");

  for (let i = 0; i < duration; i++) {
    if (isOccupied(date, court, startHour + i)) {
      bad(
        `Conflict: ${court} is already reserved at ${fmtHour(startHour + i)}.`,
        409,
      );
    }
  }

  const paymentStatus = [...PAID_METHODS, UNPAID].includes(b.paymentStatus)
    ? b.paymentStatus
    : bad("Invalid payment status.");
  const isPaid = paymentStatus !== UNPAID;

  // Prices are always calculated here – never trusted from the browser
  let courtFee = 0;
  for (let i = 0; i < duration; i++) courtFee += rateFor(startHour + i);

  const addons = [];
  let gearFee = 0;
  let paddleQty = 0;
  for (const key of Object.keys(CATALOG)) {
    const qty = Number(b.qty?.[key] ?? 0);
    if (!Number.isInteger(qty) || qty < 0 || qty > 12)
      bad("Invalid item quantity.");
    if (qty === 0) continue;
    const amount = qty * CATALOG[key].price;
    addons.push({ label: `${qty}x ${CATALOG[key].label}`, amount });
    gearFee += amount;
    if (key === "paddle") paddleQty = qty;
  }

  const reservation = {
    id: `RES-${db.meta.nextReservation++}`,
    receiptNo: isPaid ? nextReceiptNo() : null,
    date,
    channel,
    customer,
    contact,
    court,
    startHour,
    duration,
    courtFee,
    addons,
    preferences: cleanStr(b.preferences, 300) || "Standard setup",
    total: courtFee + gearFee,
    paymentStatus,
    isPaid,
    paidAt: isPaid ? stampNow() : null,
    processedBy: req.session.staffName,
    status: channel === "Walk-In" ? "Checked-In" : "Reserved",
    createdAt: new Date().toISOString(),
  };

  db.reservations.unshift(reservation);
  if (paddleQty > 0)
    createLoan(`${paddleQty}x Carbon Paddle Rental`, `${customer} (${court})`);
  saveDb();
  res.status(201).json(reservation);
});

app.post("/api/reservations/:id/status", requireAuth, jsonSmall, (req, res) => {
  const r = findReservation(req.params.id);
  const next = req.body?.status;
  const allowed = { Reserved: "Checked-In", "Checked-In": "Completed" };
  if (allowed[r.status] !== next)
    bad(`Cannot change a ${r.status} booking to ${next}.`, 409);
  r.status = next;
  saveDb();
  res.json(r);
});

app.post("/api/reservations/:id/pay", requireAuth, jsonSmall, (req, res) => {
  const r = findReservation(req.params.id);
  if (r.status === "Cancelled") bad("This booking was cancelled.", 409);
  if (r.isPaid) bad("This booking is already paid.", 409);
  const method = PAID_METHODS.includes(req.body?.method)
    ? req.body.method
    : PAID_METHODS[0];
  r.isPaid = true;
  r.paymentStatus = method;
  r.receiptNo = nextReceiptNo();
  r.paidAt = stampNow();
  r.processedBy = req.session.staffName;
  saveDb();
  res.json(r);
});

app.post("/api/reservations/:id/cancel", requireAuth, (req, res) => {
  const r = findReservation(req.params.id);
  if (r.status === "Completed")
    bad("Completed sessions cannot be cancelled.", 409);
  r.status = "Cancelled";
  saveDb();
  res.json(r);
});

// ----- Counter POS & rentals -----
app.post("/api/pos", requireAuth, jsonSmall, (req, res) => {
  const item = Object.prototype.hasOwnProperty.call(CATALOG, req.body?.item)
    ? CATALOG[req.body.item]
    : bad("Unknown item.");
  db.meta.posAmount += item.price;
  db.posSales.push({
    id: `SALE-${db.meta.nextSale++}`,
    day: req.today,
    time: stampNow(),
    item: item.label,
    price: item.price,
  });
  if (item.isRental) createLoan(`1x ${item.label}`, "Counter Walk-Up");
  saveDb();
  res.json({ ok: true, label: item.label, price: item.price });
});

app.post("/api/loans/:id/return", requireAuth, (req, res) => {
  const loan =
    db.loans.find((l) => l.id === req.params.id) || bad("Loan not found.", 404);
  if (loan.returned) bad("Already returned.", 409);
  loan.returned = true;
  loan.returnedDay = req.today;
  saveDb();
  res.json(loan);
});

// ----- Shift roster -----
app.put("/api/roster", requireAuth, jsonSmall, (req, res) => {
  const list = req.body?.roster;
  if (!Array.isArray(list) || list.length > 30) bad("Invalid roster.");
  db.roster = list.map((s) => {
    const name = cleanStr(s?.name, 60);
    if (!name) bad("Every staff member needs a name.");
    return {
      name,
      role: cleanStr(s?.role, 60) || "General Staff",
      shift: cleanStr(s?.shift, 20) || "Off Duty",
      color: /^#[0-9a-fA-F]{6}$/.test(s?.color) ? s.color : "#198754",
    };
  });
  saveDb();
  res.json(db.roster);
});

// ----- Club logo (stored as a file, served as an image) -----
app.get("/api/logo", (req, res) => {
  if (!db.meta.logoMime || !fs.existsSync(LOGO_FILE))
    return res.status(404).end();
  res.set({
    "Content-Type": db.meta.logoMime,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable", // URL changes with ?v=
  });
  res.send(fs.readFileSync(LOGO_FILE));
});

app.post("/api/logo", requireAuth, jsonLogo, (req, res) => {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
      req.body?.dataUrl || "",
    );
  if (!match) bad("Please upload a PNG, JPG, GIF, WebP or SVG image.");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 1.5 * 1024 * 1024)
    bad("Logo is too large (max 1.5 MB).", 413);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOGO_FILE, buffer);
  db.meta.logoMime = match[1];
  db.meta.logoVersion += 1;
  saveDb();
  res.json({ ok: true, logoVersion: db.meta.logoVersion });
});

app.delete("/api/logo", requireAuth, (req, res) => {
  db.meta.logoMime = null;
  db.meta.logoVersion += 1;
  try {
    fs.unlinkSync(LOGO_FILE);
  } catch (err) {
    /* already gone */
  }
  saveDb();
  res.json({ ok: true });
});

// ----- Excel reports (staff login required) -----
const REPORT_NAME =
  /^(Revenue-History|\d{4}-\d{2}\/Daily-Report-\d{4}-\d{2}-\d{2}(-v\d+)?)\.xlsx$/;

app.get("/api/reports", requireAuth, (req, res) => {
  const list = [];
  let months = [];
  try {
    months = fs.readdirSync(REPORT_DIR).filter((m) => /^\d{4}-\d{2}$/.test(m));
  } catch (err) {
    /* no reports yet */
  }
  for (const m of months) {
    for (const f of fs.readdirSync(path.join(REPORT_DIR, m))) {
      const match = /^Daily-Report-(\d{4}-\d{2}-\d{2})(-v\d+)?\.xlsx$/.exec(f);
      if (!match) continue;
      const stat = fs.statSync(path.join(REPORT_DIR, m, f));
      list.push({
        file: `${m}/${f}`,
        date: match[1],
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  list.sort((a, b) => b.file.localeCompare(a.file));
  res.json({
    reports: list,
    hasHistory: fs.existsSync(path.join(REPORT_DIR, HISTORY_XLSX)),
    folder: REPORT_DIR,
  });
});

// Today's numbers so far (does not clear anything)
app.get("/api/reports/today", requireAuth, async (req, res, next) => {
  try {
    const snap = {
      date: req.today,
      generatedAt: stampNow(),
      reservations: db.reservations.filter((r) => r.date === req.today),
      posSales: db.posSales.filter((x) => x.day === req.today),
      loans: db.loans,
    };
    const wb = await reports.buildDailyWorkbook(snap, reportCfg(), {
      partial: true,
    });
    const buf = await wb.xlsx.writeBuffer();
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Today-so-far-${req.today}.xlsx"`,
    });
    res.send(Buffer.from(buf));
  } catch (err) {
    next(err);
  }
});

app.get("/api/reports/download", requireAuth, (req, res) => {
  const file = String(req.query.file || "");
  if (!REPORT_NAME.test(file)) bad("Unknown report.", 404);
  const full = path.join(REPORT_DIR, file);
  if (!full.startsWith(REPORT_DIR) || !fs.existsSync(full))
    bad("Report not found.", 404);
  res.download(full, path.basename(file));
});

// ----- Static front-end + error handling -----
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "Invalid request body." });
  if (err.type === "entity.too.large")
    return res.status(413).json({ error: "Upload is too large." });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res
    .status(status)
    .json({ error: status === 500 ? "Server error." : err.message });
});

// Close out finished days at startup and every minute (so the Excel file is
// written right after midnight even if nobody has the app open)
rollDay();
processPendingReports();
setInterval(() => {
  try {
    rollDay();
    if (hasPending() || historyDirty) processPendingReports();
  } catch (err) {
    console.error("Daily rollover problem:", err.message);
  }
}, 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nDink & Drive is running (club timezone: ${TZ})`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  console.log(`  Daily Excel reports saved in:  ${REPORT_DIR}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal)
        console.log(
          `  Other devices:  http://${a.address}:${PORT}   (lobby TV, phones)`,
        );
    }
  }
  if (!process.env.STAFF_PASSWORD || !process.env.ADMIN_PASSWORD) {
    console.log(
      "\n  ⚠ Using default staff passwords. Set STAFF_PASSWORD and ADMIN_PASSWORD before real use.",
    );
  }
  console.log("");
});
