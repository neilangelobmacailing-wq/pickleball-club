/* ==========================================================================
   Dink & Drive – front-end logic (talks to the Node/Express API in server.js)
   ========================================================================== */

// ---------------------------------------------------------------------------
// Constants & configuration
// ---------------------------------------------------------------------------
const EMPTY_LOGO_PLACEHOLDER = `
  <i data-lucide="image-plus" class="w-4 h-4"></i>
  <span class="text-[8px] font-bold uppercase tracking-wider mt-0.5">Logo</span>
`;

const COURTS = [
  { id: "Court 1", label: "Court 1 - Indoor Pro" },
  { id: "Court 2", label: "Court 2 - Indoor Pro" },
  { id: "Court 3", label: "Court 3 - Covered Acrylic" },
  { id: "Court 4", label: "Court 4 - Outdoor" },
];

// Hourly slots from 07:00 AM (7) to 09:00 PM (21); club closes at 10 PM (22)
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
const QUICK_DAYS = 5; // quick-pick buttons on the customer display (any date can still be picked)
const POLL_MS = 4000; // how often every screen re-checks the server

const GEAR_ITEMS = [
  {
    id: "paddle",
    name: "Carbon Paddle Rental",
    desc: "T700 Raw Carbon • Per session",
    price: 150,
  },
  {
    id: "balls",
    name: "3-Pack Outdoor Balls",
    desc: "40-hole USAPA tournament spec",
    price: 280,
  },
  {
    id: "drink",
    name: "Electrolyte Drink",
    desc: "Chilled 500ml court hydration",
    price: 65,
  },
  {
    id: "grip",
    name: "Grip Tape",
    desc: "Tacky cushioned replacement overgrip",
    price: 120,
  },
];

const SHIFT_OPTIONS = [
  "08AM–04PM",
  "10AM–06PM",
  "12PM–08PM",
  "02PM–10PM",
  "04PM–10PM",
  "Off Duty",
];
const ROSTER_COLORS = ["#198754", "#0d6efd", "#fd7e14", "#6f42c1", "#d63384"];

// ---------------------------------------------------------------------------
// Dates (the SERVER decides what "today" is, so every screen agrees)
// ---------------------------------------------------------------------------
function localIso(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildDates(fromIso) {
  const base = fromIso ? new Date(`${fromIso}T12:00:00`) : new Date();
  base.setHours(12, 0, 0, 0);
  return Array.from({ length: QUICK_DAYS }, (_, idx) => {
    const d = new Date(base);
    d.setDate(base.getDate() + idx);
    const dayName =
      idx === 0
        ? "Today"
        : idx === 1
          ? "Tomorrow"
          : d.toLocaleDateString("en-US", { weekday: "short" });
    const dateStr = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return { iso: localIso(d), dayName, dateStr };
  });
}

let DATES = buildDates();

// Label for ANY date (not just the 5 quick-pick days)
function describeDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const base = new Date(`${state.currentDay}T12:00:00`);
  const diff = Math.round((d - base) / 86400000);
  const dayName =
    diff === 0
      ? "Today"
      : diff === 1
        ? "Tomorrow"
        : d.toLocaleDateString("en-US", { weekday: "short" });
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== base.getFullYear()) opts.year = "numeric";
  return { iso, dayName, dateStr: d.toLocaleDateString("en-US", opts) };
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
const state = {
  role: "customer",
  isAuthenticated: false,
  currentUser: null,
  token: null,
  isTvMode: false,
  online: true,
  clubName: "Dink & Drive",
  hasLogo: false,
  logoVersion: 0,
  currentDay: localIso(new Date()),
  selectedDate: DATES[0].iso,
  maxDate: null, // furthest bookable date (from the server)
  board: [], // public list of taken slots
  reservations: [], // staff only
  equipmentLoans: [], // staff only
  posExtraRevenue: 0, // staff only
  roster: [], // staff only
};

let lastBoardJson = "";
let lastStaffJson = "";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError("Cannot reach the server.", 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    /* empty body */
  }

  if (!res.ok) {
    if (res.status === 401 && state.token) handleSessionExpired();
    throw new ApiError(
      (data && data.error) || `Request failed (${res.status}).`,
      res.status,
    );
  }
  return data;
}

// Run a server action, refresh the screen, and show a toast either way
async function act(fn, okMessage) {
  try {
    const result = await fn();
    await refreshAll();
    if (okMessage)
      showToast(
        typeof okMessage === "function" ? okMessage(result) : okMessage,
      );
    return result;
  } catch (err) {
    showToast(err.message, "error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPeakHour(hour) {
  return hour >= 17 && hour <= 20; // 5:00 PM – 8:59 PM
}

function getHourlyRate(hour) {
  return isPeakHour(hour) ? 500 : 350;
}

function formatHour(hour) {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour;
  return `${String(displayHour).padStart(2, "0")}:00 ${period}`;
}

function isSlotOccupied(dateIso, courtId, hour) {
  return state.board.some(
    (r) =>
      r.date === dateIso &&
      r.court === courtId &&
      hour >= r.startHour &&
      hour < r.startHour + r.duration,
  );
}

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  const bgClass =
    type === "error" ? "bg-rose-600" : "bg-court-900 border border-court-700";
  toast.className = `${bgClass} text-white px-4 py-3 rounded-xl shadow-lg text-xs font-semibold flex items-center gap-2.5 transform transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto max-w-sm`;
  toast.innerHTML = `
    <span class="w-2 h-2 rounded-full ${type === "error" ? "bg-rose-200" : "bg-optic-400"} shrink-0"></span>
    <span>${esc(message)}</span>
  `;
  container.appendChild(toast);
  requestAnimationFrame(() =>
    toast.classList.remove("translate-y-2", "opacity-0"),
  );
  setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-2");
    setTimeout(() => toast.remove(), 300);
  }, 3600);
}

function setOnline(flag) {
  if (flag === state.online) return;
  state.online = flag;
  showToast(
    flag ? "Back online." : "Cannot reach the server – retrying…",
    flag ? "success" : "error",
  );
}

// ---------------------------------------------------------------------------
// Syncing with the server
// ---------------------------------------------------------------------------
function applyServerDay(iso) {
  if (!iso || iso === state.currentDay) return;
  // The date changed (midnight in the club's timezone): roll every screen forward
  state.currentDay = iso;
  DATES = buildDates(iso);
  if (state.selectedDate < iso) state.selectedDate = DATES[0].iso;
  populateDateDropdowns();
  updateStaffEntryEstimate();
  renderDateSelector();
  selectDate(state.selectedDate);
  renderStaffDashboard();
}

async function refreshBoard() {
  const data = await api("/board");
  applyServerDay(data.today);

  const json = JSON.stringify(data);
  if (json === lastBoardJson) return;
  lastBoardJson = json;

  state.board = data.board;
  if (data.maxDate && data.maxDate !== state.maxDate) {
    state.maxDate = data.maxDate;
    populateDateDropdowns();
  }
  const brandingChanged =
    data.hasLogo !== state.hasLogo || data.logoVersion !== state.logoVersion;
  state.hasLogo = data.hasLogo;
  state.logoVersion = data.logoVersion;
  if (brandingChanged) applyBrandingToUI();
  renderScheduleGrid();
}

async function refreshStaffData() {
  if (!state.isAuthenticated) return;
  const data = await api("/data");
  applyServerDay(data.today);

  const json = JSON.stringify(data);
  if (json === lastStaffJson) return;
  lastStaffJson = json;

  state.reservations = data.reservations;
  state.equipmentLoans = data.loans;
  state.posExtraRevenue = data.posExtraRevenue;
  state.roster = data.roster;
  renderStaffDashboard();
  renderRoster();
}

async function refreshAll() {
  try {
    await Promise.all([refreshBoard(), refreshStaffData()]);
    setOnline(true);
  } catch (err) {
    if (err.status === 0) setOnline(false);
  }
}

// ---------------------------------------------------------------------------
// Staff authentication & modals
// ---------------------------------------------------------------------------
function openLoginModal() {
  document.getElementById("staff-login-modal").classList.remove("hidden");
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";
  document.getElementById("login-staff-name").value = "";
  document.getElementById("login-error-msg").classList.add("hidden");
  document.getElementById("login-username").focus();
}

function closeLoginModal() {
  document.getElementById("staff-login-modal").classList.add("hidden");
}

async function handleStaffLogin(event) {
  event.preventDefault();
  const errEl = document.getElementById("login-error-msg");
  errEl.classList.add("hidden");

  try {
    const data = await api("/login", {
      method: "POST",
      body: {
        username: document.getElementById("login-username").value,
        password: document.getElementById("login-password").value,
        staffName: document.getElementById("login-staff-name").value,
      },
    });
    state.token = data.token;
    state.isAuthenticated = true;
    state.currentUser = data.staffName;
    sessionStorage.setItem("ddToken", data.token);
    sessionStorage.setItem("ddStaff", data.staffName);
    document.getElementById("logged-in-staff-badge").textContent =
      `Signed in as ${state.currentUser}`;
    closeLoginModal();
    lastStaffJson = "";
    await refreshStaffData();
    switchRole("staff");
    showToast(`Welcome back, ${state.currentUser}!`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
}

function clearSession() {
  state.token = null;
  state.isAuthenticated = false;
  state.currentUser = null;
  state.reservations = [];
  state.equipmentLoans = [];
  state.roster = [];
  state.posExtraRevenue = 0;
  lastStaffJson = "";
  sessionStorage.removeItem("ddToken");
  sessionStorage.removeItem("ddStaff");
}

function handleSessionExpired() {
  if (!state.token) return;
  clearSession();
  if (state.role === "staff") switchRole("customer");
  showToast("Your session expired. Please log in again.", "error");
}

async function logoutStaff() {
  try {
    await api("/logout", { method: "POST" });
  } catch (err) {
    /* logging out locally is enough */
  }
  clearSession();
  switchRole("customer");
  showToast("Logged out of Staff Operations securely.");
}

// ---------------------------------------------------------------------------
// Customer TV / kiosk mode
// ---------------------------------------------------------------------------
function enterCustomerTvMode() {
  state.isTvMode = true;
  document.getElementById("main-header").classList.add("hidden");
  document.getElementById("btn-exit-tv-mode").classList.remove("hidden");
  if (state.role !== "customer") switchRole("customer");
  showToast("Entered Customer TV / Lobby Display Mode.");
}

function exitCustomerTvMode() {
  state.isTvMode = false;
  document.getElementById("main-header").classList.remove("hidden");
  document.getElementById("btn-exit-tv-mode").classList.add("hidden");
  showToast("Exited TV Mode.");
}

// ---------------------------------------------------------------------------
// Role & tab switching
// ---------------------------------------------------------------------------
const ROLE_ACTIVE =
  "flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all bg-optic-400 text-court-950 shadow";
const ROLE_IDLE =
  "flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all text-court-100 hover:text-white";

function switchRole(role) {
  if (role === "staff" && !state.isAuthenticated) {
    openLoginModal();
    return;
  }

  state.role = role;
  const isCustomer = role === "customer";
  document
    .getElementById("view-customer")
    .classList.toggle("hidden", !isCustomer);
  document.getElementById("view-staff").classList.toggle("hidden", isCustomer);
  document.getElementById("btn-role-customer").className = isCustomer
    ? ROLE_ACTIVE
    : ROLE_IDLE;
  document.getElementById("btn-role-staff").className = isCustomer
    ? ROLE_IDLE
    : ROLE_ACTIVE;

  if (isCustomer) {
    renderScheduleGrid();
  } else {
    document.getElementById("logged-in-staff-badge").textContent =
      `Signed in as ${state.currentUser}`;
    switchStaffTab("entry");
    renderStaffDashboard();
    renderRoster();
  }
  lucide.createIcons();
}

function switchStaffTab(tabName) {
  document
    .querySelectorAll(".staff-panel")
    .forEach((p) => p.classList.add("hidden"));
  const activePanel = document.getElementById(`staff-panel-${tabName}`);
  if (activePanel) activePanel.classList.remove("hidden");

  ["entry", "bookings", "pos", "reports"].forEach((t) => {
    const btn = document.getElementById(`nav-tab-${t}`);
    if (!btn) return;
    btn.className =
      t === tabName
        ? "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-court-50 text-court-900 font-bold border border-court-200/60 transition text-left"
        : "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-slate-700 transition text-left";
  });
  lucide.createIcons();
  if (tabName === "reports") loadReports();
}

// ---------------------------------------------------------------------------
// Excel revenue reports
// ---------------------------------------------------------------------------
function fmtSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadReports() {
  const list = document.getElementById("reports-list");
  try {
    const data = await api("/reports");
    document.getElementById("btn-report-history").classList.toggle(
      "hidden",
      !data.hasHistory,
    );
    if (data.reports.length === 0) {
      list.innerHTML = `<p class="text-slate-400">No daily reports yet. The first one is created right after midnight.</p>`;
      return;
    }
    // Group by month, newest first
    const months = {};
    for (const r of data.reports) (months[r.date.slice(0, 7)] ||= []).push(r);
    list.innerHTML = Object.entries(months)
      .map(([month, items], idx) => {
        const label = new Date(`${month}-01T12:00:00`).toLocaleDateString(
          "en-US",
          { month: "long", year: "numeric" },
        );
        const rows = items
          .map((r) => {
            const d = new Date(`${r.date}T12:00:00`).toLocaleDateString(
              "en-US",
              { weekday: "short", month: "short", day: "numeric", year: "numeric" },
            );
            return `
            <div class="flex items-center justify-between p-2.5 rounded-xl border border-slate-100 bg-slate-50/60">
              <div>
                <p class="font-bold text-slate-900">${esc(d)}</p>
                <p class="text-[11px] text-slate-500">${esc(r.file.split("/")[1])} • ${fmtSize(r.size)}</p>
              </div>
              <button type="button" onclick="downloadReport('${esc(r.file)}')"
                class="px-3 py-1.5 rounded-lg bg-white border border-court-300 hover:bg-court-50 text-court-900 font-bold text-[11px] transition">Download</button>
            </div>`;
          })
          .join("");
        return `
          <details ${idx === 0 ? "open" : ""} class="rounded-xl border border-slate-200 p-3">
            <summary class="cursor-pointer font-bold text-slate-800">${esc(label)} <span class="text-slate-400 font-medium">(${items.length} day${items.length === 1 ? "" : "s"})</span></summary>
            <div class="space-y-2 mt-3">${rows}</div>
          </details>`;
      })
      .join("");
  } catch (err) {
    list.innerHTML = `<p class="text-rose-600">${esc(err.message)}</p>`;
  }
}

async function downloadReport(which) {
  const url =
    which === "today"
      ? "/api/reports/today"
      : which === "history"
        ? "/api/reports/download?file=Revenue-History.xlsx"
        : `/api/reports/download?file=${encodeURIComponent(which)}`;
  const name =
    which === "today"
      ? `Today-so-far-${state.currentDay}.xlsx`
      : which === "history"
        ? "Revenue-History.xlsx"
        : which.split("/")[1];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${state.token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = `Download failed (${res.status}).`;
      try {
        msg = (await res.json()).error || msg;
      } catch (e) {
        /* not JSON */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showToast(`Downloaded ${name}`);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Club logo (stored on the server so every screen shows it)
// ---------------------------------------------------------------------------
function handleDirectLogoUpload(event) {
  const input = event.target;
  const file = input.files[0];
  input.value = ""; // allow choosing the same file again later
  if (!file) return;

  if (!state.isAuthenticated) {
    showToast("Please log in as staff to change the club logo.", "error");
    openLoginModal();
    return;
  }
  if (!file.type.startsWith("image/")) {
    showToast("Please select a valid image file (PNG, JPG, SVG).", "error");
    return;
  }
  if (file.size > 1.5 * 1024 * 1024) {
    showToast("Logo is too large (max 1.5 MB).", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const result = await act(
      () =>
        api("/logo", { method: "POST", body: { dataUrl: e.target.result } }),
      `Logo saved! Now shown beside ${state.clubName}, on the lobby TV and on receipts.`,
    );
    if (result) lastBoardJson = "";
  };
  reader.readAsDataURL(file);
}

function applyBrandingToUI() {
  const logoMarkup = state.hasLogo
    ? `<img src="/api/logo?v=${state.logoVersion}" alt="${esc(state.clubName)} Logo" class="w-full h-full object-cover" />`
    : EMPTY_LOGO_PLACEHOLDER;

  const headerWrapper = document.getElementById("header-logo-wrapper");
  const lobbyWrapper = document.getElementById("lobby-logo-wrapper");
  const receiptWrapper = document.getElementById("receipt-logo-wrapper");

  headerWrapper.innerHTML = logoMarkup;
  lobbyWrapper.innerHTML = logoMarkup;
  receiptWrapper.innerHTML = state.hasLogo
    ? logoMarkup
    : `<span class="text-[10px] font-bold uppercase tracking-wider text-court-900">LOGO</span>`;

  [headerWrapper, lobbyWrapper].forEach((el) => {
    el.classList.toggle("border-2", !state.hasLogo);
    el.classList.toggle("border-dashed", !state.hasLogo);
  });

  document.getElementById("header-club-name").textContent = state.clubName;
  document.getElementById("lobby-club-badge").textContent = state.clubName;
  document.getElementById("receipt-club-name").textContent = state.clubName;
  lucide.createIcons();
}

// ---------------------------------------------------------------------------
// VIEW 1: Customer display (read-only)
// ---------------------------------------------------------------------------
function renderDateSelector() {
  const container = document.getElementById("date-selector");
  container.innerHTML = DATES.map((d) => {
    const active = d.iso === state.selectedDate;
    return `
      <button onclick="selectDate('${d.iso}')"
        class="px-3.5 py-2 rounded-xl text-left transition min-w-[84px] border ${
          active
            ? "bg-optic-400 text-court-950 border-optic-300 font-bold shadow"
            : "bg-white/5 hover:bg-white/15 text-white border-white/10"
        }">
        <div class="text-[11px] uppercase tracking-wider opacity-80">${d.dayName}</div>
        <div class="text-sm font-extrabold">${d.dateStr}</div>
      </button>
    `;
  }).join("");
}

function pickViewDate(iso) {
  // Customer picked a date from the calendar box
  if (!iso) return;
  if (iso < state.currentDay) {
    showToast("That date has already passed.", "error");
    return selectDate(state.selectedDate);
  }
  if (state.maxDate && iso > state.maxDate) {
    showToast("That date is too far ahead to book yet.", "error");
    return selectDate(state.selectedDate);
  }
  selectDate(iso);
}

function selectDate(dateIso) {
  state.selectedDate = dateIso;
  const found = describeDate(dateIso);
  document.getElementById("selected-date-label").textContent =
    `Showing live board for ${found.dayName}, ${found.dateStr}`;
  document.getElementById("view-date-picker").value = dateIso;
  renderDateSelector();
  renderScheduleGrid();
}

function renderScheduleGrid() {
  const tbody = document.getElementById("schedule-grid-body");
  tbody.innerHTML = HOURS.map((hour) => {
    const peak = isPeakHour(hour);
    const rate = getHourlyRate(hour);

    const cells = COURTS.map((court) => {
      if (isSlotOccupied(state.selectedDate, court.id, hour)) {
        return `
          <td class="p-2">
            <div class="w-full py-2 px-2.5 rounded-xl bg-slate-100 border border-slate-200/90 text-slate-400 text-[11px] font-bold text-center select-none uppercase tracking-wider">
              RESERVED
            </div>
          </td>`;
      }
      const badgeStyle = peak
        ? "bg-amber-50/80 border-amber-300/80 text-amber-900"
        : "bg-emerald-50/80 border-emerald-300/80 text-court-900";
      return `
        <td class="p-2">
          <div class="w-full py-2 px-2.5 rounded-xl border ${badgeStyle} text-center select-none">
            <div class="text-[11px] font-extrabold tracking-wide uppercase">AVAILABLE</div>
            <div class="text-[10px] font-semibold opacity-80">₱${rate}/hr</div>
          </div>
        </td>`;
    }).join("");

    return `
      <tr class="hover:bg-slate-50/40">
        <td class="py-2.5 px-4 font-semibold text-xs text-slate-700 whitespace-nowrap sticky left-0 bg-white z-10 border-r border-slate-100">
          <div>${formatHour(hour)}</div>
          ${peak ? '<span class="text-[10px] text-amber-600 font-bold">PEAK</span>' : ""}
        </td>
        ${cells}
      </tr>`;
  }).join("");
}

function renderCustomerGearShowcase() {
  document.getElementById("customer-gear-showcase").innerHTML = GEAR_ITEMS.map(
    (item) => `
      <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200/80 bg-slate-50/60">
        <div>
          <p class="text-xs font-bold text-slate-900">${item.name}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">${item.desc}</p>
        </div>
        <span class="text-xs font-extrabold text-court-800 bg-court-100/80 px-2.5 py-1 rounded-lg">₱${item.price}</span>
      </div>`,
  ).join("");
}

// ---------------------------------------------------------------------------
// VIEW 2: Staff dashboard – reservation form
// ---------------------------------------------------------------------------
function populateDateDropdowns() {
  // Date boxes accept ANY day from today up to the server's booking limit
  const min = state.currentDay;
  const max = state.maxDate || "";
  const ids = ["entry-date", "staff-date-filter", "view-date-picker"];
  for (const id of ids) {
    const el = document.getElementById(id);
    el.min = min;
    if (max) el.max = max;
    if (!el.value || el.value < min) el.value = id === "view-date-picker" ? state.selectedDate : min;
  }
}

function populateStaffFormDropdowns() {
  populateDateDropdowns();
  const entryHour = document.getElementById("entry-hour");
  entryHour.innerHTML = HOURS.map(
    (h) =>
      `<option value="${h}">${formatHour(h)} (${isPeakHour(h) ? "Peak ₱500" : "Off-Peak ₱350"})</option>`,
  ).join("");
  entryHour.value = "16";
  updateStaffEntryEstimate();
}

function readQty(id) {
  return parseInt(document.getElementById(id).value, 10) || 0;
}

function updateStaffEntryEstimate() {
  const startHour =
    parseInt(document.getElementById("entry-hour").value, 10) || 16;
  const duration =
    parseInt(document.getElementById("entry-duration").value, 10) || 1;

  let courtFee = 0;
  for (let i = 0; i < duration; i++) courtFee += getHourlyRate(startHour + i);

  const gearFee =
    readQty("entry-qty-paddle") * 150 +
    readQty("entry-qty-balls") * 280 +
    readQty("entry-qty-drink") * 65 +
    readQty("entry-qty-grip") * 120;

  document.getElementById("entry-total-preview").textContent =
    `₱${(courtFee + gearFee).toLocaleString()}`;
}

async function submitStaffReservation(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const date = document.getElementById("entry-date").value;
  const payload = {
    channel: document.querySelector('input[name="booking-channel"]:checked')
      .value,
    customer: document.getElementById("entry-customer-name").value.trim(),
    contact: document.getElementById("entry-customer-contact").value.trim(),
    date,
    court: document.getElementById("entry-court").value,
    startHour: parseInt(document.getElementById("entry-hour").value, 10),
    duration: parseInt(document.getElementById("entry-duration").value, 10),
    qty: {
      paddle: readQty("entry-qty-paddle"),
      balls: readQty("entry-qty-balls"),
      drink: readQty("entry-qty-drink"),
      grip: readQty("entry-qty-grip"),
    },
    preferences: document.getElementById("entry-preferences").value.trim(),
    paymentStatus: document.getElementById("entry-payment-status").value,
  };

  const created = await act(
    () => api("/reservations", { method: "POST", body: payload }),
    (r) => `Saved ${r.channel} booking for ${r.customer} on ${r.court}!`,
  );
  submitBtn.disabled = false;
  if (!created) return; // error toast already shown (e.g. slot conflict)

  document.getElementById("staff-entry-form").reset();
  document.getElementById("entry-date").value = date;
  document.getElementById("entry-hour").value = "16";
  updateStaffEntryEstimate();
  document.getElementById("staff-date-filter").value = date;
  renderStaffDashboard();
  switchStaffTab("bookings");

  if (created.isPaid) openReceiptModal(created.id);
}

// ---------------------------------------------------------------------------
// VIEW 2: Staff dashboard – KPIs, bookings table, rentals
// ---------------------------------------------------------------------------
function renderStaffDashboard() {
  const filterDate =
    document.getElementById("staff-date-filter").value || state.currentDay;

  const todayBookings = state.reservations.filter(
    (r) => r.date === state.currentDay,
  );
  const activeCourts = todayBookings.filter(
    (r) => r.status === "Checked-In",
  ).length;
  const pendingReturns = state.equipmentLoans.filter((l) => !l.returned).length;
  const collectedBookingRev = todayBookings
    .filter((r) => r.isPaid)
    .reduce((sum, r) => sum + r.total, 0);

  document.getElementById("kpi-total-bookings").textContent =
    todayBookings.length;
  document.getElementById("kpi-active-courts").textContent =
    `${activeCourts} / ${COURTS.length}`;
  document.getElementById("kpi-gear-loan").textContent = pendingReturns;
  document.getElementById("kpi-revenue").textContent =
    `₱${(collectedBookingRev + state.posExtraRevenue).toLocaleString()}`;

  const filteredBookings = state.reservations.filter(
    (r) => r.date === filterDate,
  );
  const tbody = document.getElementById("staff-bookings-tbody");

  if (filteredBookings.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-8 text-center text-xs text-slate-400">
          No active reservations logged for this date yet. Use the Log Reservation tab to add a Walk-In or Text/Chat booking.
        </td>
      </tr>`;
  } else {
    tbody.innerHTML = filteredBookings.map(renderBookingRow).join("");
  }

  const loansContainer = document.getElementById("active-rentals-list");
  if (state.equipmentLoans.length === 0) {
    loansContainer.innerHTML = `<p class="text-xs text-slate-400">No active paddle rentals logged.</p>`;
  } else {
    loansContainer.innerHTML = state.equipmentLoans
      .map(
        (loan) => `
        <div class="flex items-center justify-between p-2.5 rounded-xl border ${
          loan.returned
            ? "bg-slate-50 border-slate-100 opacity-60"
            : "bg-amber-50/60 border-amber-200/80"
        } text-xs">
          <div>
            <p class="font-bold text-slate-900">${esc(loan.item)}</p>
            <p class="text-[11px] text-slate-500">${esc(loan.holder)}</p>
          </div>
          ${
            loan.returned
              ? '<span class="text-[11px] font-bold text-emerald-700">✓ Returned</span>'
              : `<button onclick="markLoanReturned('${esc(loan.id)}')" class="px-2.5 py-1 rounded-lg bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 font-bold text-[11px] transition">Mark Returned</button>`
          }
        </div>`,
      )
      .join("");
  }
}

function renderBookingRow(r) {
  const channelBadge =
    r.channel === "Walk-In"
      ? "bg-court-100 text-court-800 border-court-200"
      : "bg-sky-100 text-sky-800 border-sky-200";

  let sessionBadge = "bg-amber-100 text-amber-800";
  if (r.status === "Checked-In")
    sessionBadge = "bg-emerald-100 text-emerald-800";
  if (r.status === "Completed") sessionBadge = "bg-slate-100 text-slate-600";

  let sessionActionBtn = "";
  if (r.status === "Reserved") {
    sessionActionBtn = `<button onclick="updateSessionStatus('${esc(r.id)}', 'Checked-In')" class="px-2.5 py-1 rounded-lg bg-court-700 hover:bg-court-800 text-white text-[11px] font-bold transition">Check In</button>`;
  } else if (r.status === "Checked-In") {
    sessionActionBtn = `<button onclick="updateSessionStatus('${esc(r.id)}', 'Completed')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-bold transition">Complete</button>`;
  }

  const paymentCell = r.isPaid
    ? `<div class="flex flex-wrap items-center gap-1 mt-1">
         <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">✓ Paid</span>
         <button onclick="openReceiptModal('${esc(r.id)}')" class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-900 text-white transition">Receipt</button>
       </div>`
    : `<button onclick="markReservationPaid('${esc(r.id)}')" class="mt-1 text-[10px] font-bold px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition">Unpaid • Pay &amp; Receipt</button>`;

  return `
    <tr class="hover:bg-slate-50/80 transition align-top">
      <td class="py-3.5 px-4">
        <span class="inline-block text-[10px] font-extrabold px-2 py-0.5 rounded border ${channelBadge} uppercase">${esc(r.channel)}</span>
        <div class="font-bold text-slate-900 mt-1">${esc(r.customer)}</div>
        <div class="text-[11px] text-slate-500">${esc(r.contact)}</div>
      </td>
      <td class="py-3.5 px-4">
        <div class="font-bold text-slate-800">${esc(r.court)}</div>
        <div class="text-xs text-slate-600">${formatHour(r.startHour)} – ${formatHour(r.startHour + r.duration)}</div>
        <div class="text-[10px] text-slate-400 font-semibold">${r.duration} hr(s)</div>
      </td>
      <td class="py-3.5 px-4 max-w-[210px]">
        <p class="text-[11px] text-slate-700 bg-amber-50/70 border border-amber-200/70 rounded-lg px-2 py-1 italic">"${esc(r.preferences)}"</p>
        ${r.addons.length ? `<div class="text-[11px] font-semibold text-court-800 mt-1.5">${r.addons.map((a) => esc(a.label)).join(", ")}</div>` : ""}
      </td>
      <td class="py-3.5 px-4">
        <div class="font-extrabold text-slate-900">₱${r.total.toLocaleString()}</div>
        ${paymentCell}
      </td>
      <td class="py-3.5 px-4">
        <span class="px-2.5 py-1 rounded-full text-[11px] font-bold ${sessionBadge}">${esc(r.status)}</span>
      </td>
      <td class="py-3.5 px-4 text-right space-x-1 whitespace-nowrap">
        ${sessionActionBtn}
        ${r.status !== "Completed" ? `<button onclick="cancelReservation('${esc(r.id)}')" title="Cancel Booking" class="px-2 py-1 rounded-lg border border-slate-200 hover:bg-rose-50 hover:text-rose-700 text-slate-500 text-[11px] font-bold transition">Cancel</button>` : ""}
      </td>
    </tr>`;
}

async function markReservationPaid(resId) {
  const paid = await act(
    () => api(`/reservations/${resId}/pay`, { method: "POST", body: {} }),
    (r) =>
      `Payment collected for ${r.customer} (₱${r.total}). Generating receipt...`,
  );
  if (paid) openReceiptModal(resId);
}

function updateSessionStatus(resId, newStatus) {
  const booking = state.reservations.find((r) => r.id === resId);
  return act(
    () =>
      api(`/reservations/${resId}/status`, {
        method: "POST",
        body: { status: newStatus },
      }),
    booking
      ? `${booking.customer} (${booking.court}) marked as ${newStatus}.${newStatus === "Completed" ? " Slot is now free on the display board." : ""}`
      : "Status updated.",
  );
}

function cancelReservation(resId) {
  const booking = state.reservations.find((r) => r.id === resId);
  if (booking && !confirm(`Cancel the reservation for ${booking.customer}?`))
    return;
  return act(
    () => api(`/reservations/${resId}/cancel`, { method: "POST" }),
    booking
      ? `Cancelled reservation for ${booking.customer}. Slot freed on display board.`
      : "Cancelled.",
  );
}

function quickPosSale(itemId) {
  return act(
    () => api("/pos", { method: "POST", body: { item: itemId } }),
    (r) => `Logged counter sale: ${r.label} (₱${r.price})`,
  );
}

function markLoanReturned(loanId) {
  const loan = state.equipmentLoans.find((l) => l.id === loanId);
  return act(
    () => api(`/loans/${loanId}/return`, { method: "POST" }),
    loan ? `Paddle returned & inspected (${loan.item}).` : "Paddle returned.",
  );
}

// ---------------------------------------------------------------------------
// Official receipt modal
// ---------------------------------------------------------------------------
function openReceiptModal(resId) {
  const booking = state.reservations.find((r) => r.id === resId);
  if (!booking) return;

  applyBrandingToUI();
  document.getElementById("receipt-number").textContent =
    booking.receiptNo || "OR-TEMP";
  document.getElementById("receipt-issued-at").textContent =
    booking.paidAt || new Date().toLocaleString();
  document.getElementById("receipt-customer").textContent =
    `${booking.customer} (${booking.contact})`;
  document.getElementById("receipt-channel").textContent = booking.channel;
  document.getElementById("receipt-payment-method").textContent =
    booking.paymentStatus;
  document.getElementById("receipt-processed-by").textContent =
    booking.processedBy || state.currentUser || "Front Desk";
  document.getElementById("receipt-preferences").textContent =
    booking.preferences || "Standard setup";
  document.getElementById("receipt-total-amount").textContent =
    `₱${booking.total.toLocaleString()}.00`;

  const items = [
    `<div class="flex items-center justify-between text-slate-800">
       <span>${esc(booking.court)} (${formatHour(booking.startHour)} – ${formatHour(booking.startHour + booking.duration)})</span>
       <span class="font-bold">₱${booking.courtFee.toLocaleString()}</span>
     </div>`,
    ...booking.addons.map(
      (addon) => `
      <div class="flex items-center justify-between text-slate-700">
        <span>${esc(addon.label)}</span>
        <span class="font-bold">₱${addon.amount.toLocaleString()}</span>
      </div>`,
    ),
  ];

  document.getElementById("receipt-items-list").innerHTML = items.join("");
  document.getElementById("receipt-modal").classList.remove("hidden");
  lucide.createIcons();
}

function closeReceiptModal() {
  document.getElementById("receipt-modal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Shift roster (saved on the server)
// ---------------------------------------------------------------------------
function initials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function renderRoster() {
  const list = document.getElementById("roster-list");
  list.innerHTML = state.roster
    .map((staff, index) => {
      const options = Array.from(new Set([staff.shift, ...SHIFT_OPTIONS]))
        .map(
          (s) =>
            `<option value="${esc(s)}" ${s === staff.shift ? "selected" : ""}>${esc(s)}</option>`,
        )
        .join("");
      return `
        <div class="roster-row" data-staff="${esc(staff.name)}">
          <div class="roster-person">
            <span class="badge" style="background:${esc(staff.color)}">${esc(initials(staff.name))}</span>
            <div>
              <strong>${esc(staff.name)}</strong>
              <span class="role">${esc(staff.role)}</span>
            </div>
          </div>
          <div class="roster-controls">
            <select class="shift-time-select" onchange="updateShift(${index}, this.value)">${options}</select>
            <button class="roster-remove-btn" title="Remove Staff" onclick="removeStaff(${index})">&times;</button>
          </div>
        </div>`;
    })
    .join("");
  const active = state.roster.filter((s) => s.shift !== "Off Duty").length;
  document.getElementById("active-count").textContent = `${active} Active`;
}

function saveRoster(okMessage) {
  return act(
    () => api("/roster", { method: "PUT", body: { roster: state.roster } }),
    okMessage,
  );
}

function updateShift(index, newShift) {
  const staff = state.roster[index];
  if (!staff) return;
  staff.shift = newShift;
  renderRoster();
  saveRoster(`Updated ${staff.name}'s shift to ${newShift}`);
}

function removeStaff(index) {
  const staff = state.roster[index];
  if (!staff) return;
  if (
    !confirm(`Are you sure you want to remove ${staff.name} from the roster?`)
  )
    return;
  state.roster.splice(index, 1);
  renderRoster();
  saveRoster(`Removed ${staff.name} from roster.`);
}

function openAddStaffModal() {
  const name = (prompt("Enter Staff Member Name:") || "").trim();
  if (!name) return;
  const role = (
    prompt(
      "Enter Role (e.g., Front Desk, Court Marshal, Pro Shop):",
      "General Staff",
    ) || "General Staff"
  ).trim();
  const shift = (
    prompt("Enter Shift Time (e.g., 08AM–04PM):", "02PM–10PM") || "02PM–10PM"
  ).trim();

  state.roster.push({
    name,
    role,
    shift,
    color: ROSTER_COLORS[Math.floor(Math.random() * ROSTER_COLORS.length)],
  });
  renderRoster();
  saveRoster(`Added ${name} to the roster.`);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.isTvMode) exitCustomerTvMode();
  closeReceiptModal();
  closeLoginModal();
});

// ---------------------------------------------------------------------------
// Initialise on load
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  applyBrandingToUI();
  renderDateSelector();
  renderScheduleGrid();
  renderCustomerGearShowcase();
  populateStaffFormDropdowns();
  renderStaffDashboard();
  lucide.createIcons();

  // Restore a staff session after a page refresh (cleared when the tab closes)
  const savedToken = sessionStorage.getItem("ddToken");
  if (savedToken) {
    state.token = savedToken;
    state.isAuthenticated = true;
    state.currentUser = sessionStorage.getItem("ddStaff") || "Staff";
    document.getElementById("logged-in-staff-badge").textContent =
      `Signed in as ${state.currentUser}`;
  }

  await refreshAll();

  // Every screen (front desk, lobby TV, phones) re-checks the server regularly
  setInterval(() => {
    if (!document.hidden) refreshAll();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll();
  });
});
