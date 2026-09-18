import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  firebaseConfig,
  firebaseConfigBackup,
  firestoreDatabaseId,
  firestoreDatabaseIdBackup
} from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firestoreDatabaseId);

// Database di backup: entra in gioco quando il primario esaurisce la quota giornaliera.
const backupApp = initializeApp(firebaseConfigBackup, "backup");
const dbBackup = getFirestore(backupApp, firestoreDatabaseIdBackup);

// true mentre il primario risponde con quota esaurita: le operazioni vanno sul backup.
let usingBackupDb = false;

function isQuotaError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "resource-exhausted"
    || code === "unavailable"
    || message.includes("quota")
    || message.includes("resource-exhausted");
}

function currentDb() {
  return usingBackupDb ? dbBackup : db;
}

// Esegue l'operazione sul DB primario; se la quota e' esaurita passa al backup e la riprova.
async function withDbFailover(operation) {
  if (usingBackupDb) {
    return operation(dbBackup);
  }
  try {
    return await operation(db);
  } catch (error) {
    if (!isQuotaError(error)) {
      throw error;
    }
    console.warn("[admin-web] Quota primario esaurita, passaggio al database di backup:", error.message);
    usingBackupDb = true;
    updateDbBadge();
    return operation(dbBackup);
  }
}

// Prova a tornare sul primario (chiamata periodicamente: la quota si resetta ogni giorno).
async function tryRestorePrimaryDb() {
  if (!usingBackupDb) return;
  try {
    await getDocs(query(collection(db, "orders")));
    usingBackupDb = false;
    console.log("[admin-web] Database primario di nuovo disponibile");
    updateDbBadge();
  } catch (_error) {
    // Ancora in quota-exceeded: resta sul backup.
  }
}

function updateDbBadge() {
  const badge = document.getElementById("dbStatusBadge");
  if (!badge) return;
  badge.classList.remove("hidden", "is-backup");
  if (usingBackupDb) {
    badge.textContent = "DB: BACKUP";
    badge.classList.add("is-backup");
  } else {
    badge.textContent = "DB: PRIMARIO";
  }
}

// Scrive lo stesso documento su entrambi i database (best-effort sul secondario).
async function setDocBoth(collectionName, docId, payload) {
  await withDbFailover((target) => setDoc(doc(target, collectionName, docId), payload));
  const otherDb = usingBackupDb ? db : dbBackup;
  try {
    await setDoc(doc(otherDb, collectionName, docId), payload);
  } catch (error) {
    console.warn(`[admin-web] Sync secondario fallita (${collectionName}/${docId}):`, error.message);
  }
}

async function updateDocBoth(collectionName, docId, payload) {
  await withDbFailover((target) => updateDoc(doc(target, collectionName, docId), payload));
  const otherDb = usingBackupDb ? db : dbBackup;
  try {
    await updateDoc(doc(otherDb, collectionName, docId), payload);
  } catch (error) {
    console.warn(`[admin-web] Sync secondario fallita (${collectionName}/${docId}):`, error.message);
  }
}

const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const loginStatus = document.getElementById("loginStatus");
const ordersStatus = document.getElementById("ordersStatus");
const ordersList = document.getElementById("ordersList");
const ordersEmptyState = document.getElementById("ordersEmptyState");
const statusFilter = document.getElementById("statusFilter");
const modelFilter = document.getElementById("modelFilter");
const logoutButton = document.getElementById("logoutButton");
const refreshOrdersButton = document.getElementById("refreshOrdersButton");
const sessionActions = document.getElementById("sessionActions");
const adminIdentityCard = document.getElementById("adminIdentityCard");
const adminAvatar = document.getElementById("adminAvatar");
const adminName = document.getElementById("adminName");
const adminEmail = document.getElementById("adminEmail");
const newOrdersNotice = document.getElementById("newOrdersNotice");
const orderDetailModal = document.getElementById("orderDetailModal");
const closeOrderDetailButton = document.getElementById("closeOrderDetailButton");
const selectedOrderDetail = document.getElementById("selectedOrderDetail");
const orderHistoryList = document.getElementById("orderHistoryList");
const modalTitle = document.getElementById("modalTitle");

let currentAdminProfile = null;
let allOrders = [];
let ordersUnsubscribe = null;

function setStatus(target, type, message) {
  target.textContent = message || "";
  target.classList.remove("error", "success");
  if (type) {
    target.classList.add(type);
  }
}

function setNewOrdersNotice(visible) {
  newOrdersNotice.classList.toggle("hidden", !visible);
}

function getInitials(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "AD";
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("it-IT");
}

function formatCurrency(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? `EUR ${amount.toFixed(2)}` : "-";
}

function normalizeDateField(data, fieldName, fallbackFieldName) {
  const directValue = data[fieldName];
  if (directValue?.toDate) {
    return directValue.toDate().toISOString();
  }
  if (typeof directValue === "string" && directValue.trim()) {
    return directValue;
  }
  const fallbackValue = data[fallbackFieldName];
  if (typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) {
    return new Date(fallbackValue).toISOString();
  }
  return "";
}

function mapOrder(docSnapshot) {
  const data = docSnapshot.data();
  return {
    id: Number(data.id || docSnapshot.id),
    userUid: data.userUid || "",
    userEmail: data.userEmail || "",
    username: data.username || "",
    nome: data.nome || "Veicolo",
    modello: data.modello || "-",
    anno: data.anno || "-",
    tipo_motore: data.tipo_motore || "-",
    marca_centralina: data.marca_centralina || "-",
    chilometri: data.chilometri ?? "-",
    richiesta: data.richiesta || "-",
    read_mode: data.read_mode || "-",
    stato: data.stato || "pending",
    pagamento_stato: data.pagamento_stato || "not_required",
    prezzo_lavorazione: data.prezzo_lavorazione ?? null,
    esito_admin_note: data.esito_admin_note || "",
    created_at: normalizeDateField(data, "createdAt", "createdAtMs"),
    approvato_at: normalizeDateField(data, "approvatoAt", "approvedAtMs"),
    consegnato_at: normalizeDateField(data, "consegnatoAt", "consegnatoAtMs"),
    delivery_file: data.delivery_file || null,
    mappa_descrizione: data.mappa_descrizione || "",
    files: Array.isArray(data.files) ? data.files : []
  };
}

function sortOrders(rows) {
  return [...rows].sort((left, right) => {
    const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0;
    const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0;
    return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
  });
}

function refreshModelFilter() {
  const selectedValue = modelFilter.value;
  const models = [...new Set(allOrders.map((order) => String(order.modello || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  modelFilter.innerHTML = '<option value="all">Tutti i modelli</option>';
  models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelFilter.appendChild(option);
  });
  modelFilter.value = models.includes(selectedValue) ? selectedValue : "all";
}

function closeOrderDetail() {
  orderDetailModal.classList.add("hidden");
}

function renderHistoryDeliveryMarkup(entry) {
  const deliveryFile = entry.delivery_file;
  if (!deliveryFile || !deliveryFile.file_key) {
    return '<small class="history-delivery-empty">Nessuna mappatura inviata per questo ordine.</small>';
  }

  const description = entry.mappa_descrizione || `Mappatura ${[entry.nome, entry.modello].filter(Boolean).join(" ") || "veicolo"}`;
  return `
    <div class="history-delivery">
      <small><strong>Mappatura inviata:</strong> ${description}</small>
      <div class="history-delivery-row">
        <span>${deliveryFile.nome_file || "file"} · ${formatDateTime(entry.consegnato_at)}</span>
        <button class="delivery-download-button history-delivery-download" data-order-id="${entry.id}" type="button">Scarica file inviato</button>
      </div>
    </div>
  `;
}

function openOrderDetail(orderId) {
  const order = allOrders.find((entry) => Number(entry.id) === Number(orderId));
  if (!order) return;

  const sameVehicleHistory = sortOrders(allOrders.filter((entry) =>
    Number(entry.id) !== Number(order.id)
    && String(entry.userUid || entry.userEmail) === String(order.userUid || order.userEmail)
    && String(entry.nome || "").trim().toLowerCase() === String(order.nome || "").trim().toLowerCase()
    && String(entry.modello || "").trim().toLowerCase() === String(order.modello || "").trim().toLowerCase()
  ));

  modalTitle.textContent = `${order.nome} ${order.modello}`;
  selectedOrderDetail.innerHTML = `
    <div class="selected-request-meta">
      <span>Ordine #${order.id}</span><span>${formatDateTime(order.created_at)}</span><span>${order.tipo_motore} · ${order.anno}</span>
    </div>
    <p>${order.richiesta}</p>
    ${order.esito_admin_note ? `<p class="order-note"><strong>Esito admin:</strong> ${order.esito_admin_note}</p>` : ""}
    ${renderHistoryDeliveryMarkup(order)}
  `;

  orderHistoryList.innerHTML = sameVehicleHistory.length > 0
    ? sameVehicleHistory.map((entry) => `
      <article class="history-request">
        <div><button class="history-order-button" data-order-id="${entry.id}" type="button">Ordine #${entry.id}</button><span>${formatDateTime(entry.created_at)} · ${entry.stato}</span></div>
        <p>${entry.richiesta}</p>
        ${entry.esito_admin_note ? `<small>Esito admin: ${entry.esito_admin_note}</small>` : ""}
        ${renderHistoryDeliveryMarkup(entry)}
      </article>
    `).join("")
    : '<p class="history-empty">Nessuna richiesta precedente per questo cliente e modello.</p>';
  orderDetailModal.classList.remove("hidden");
}

function renderOrders() {
  const filterValue = statusFilter.value;
  const filteredByStatus = filterValue === "all"
    ? allOrders
    : allOrders.filter((order) => order.stato === filterValue);
  const filteredOrders = modelFilter.value === "all"
    ? filteredByStatus
    : filteredByStatus.filter((order) => order.modello === modelFilter.value);

  ordersList.innerHTML = "";
  ordersEmptyState.classList.toggle("hidden", filteredOrders.length > 0);

  if (filteredOrders.length === 0) {
    return;
  }

  filteredOrders.forEach((order) => {
    const article = document.createElement("article");
    article.className = "order-card";

    const filesMarkup = order.files.length === 0
      ? `<div class="meta-card"><strong>File allegati</strong><span>Nessun file caricato</span></div>`
      : `
        <div class="order-files">
          ${order.files.map((file, index) => `
            <div class="file-card">
              <div>
                <strong>${file.categoria || "file"}</strong>
                <div>${file.nome_file || `File ${index + 1}`}</div>
              </div>
              <button class="download-button" data-order-id="${order.id}" data-file-index="${index}" type="button">Scarica</button>
            </div>
          `).join("")}
        </div>
      `;

    const deliveryMarkup = `
      <div class="delivery-card">
        <div class="delivery-head">
          <strong>Mappatura completata</strong>
          ${order.delivery_file
            ? `<span>Inviata: ${order.delivery_file.nome_file || "file"} · ${formatDateTime(order.consegnato_at)}</span>`
            : "<span>Nessun file inviato al cliente</span>"}
        </div>
        <div class="delivery-actions">
          <input type="file" class="delivery-file-input" id="delivery-file-${order.id}" />
          <button class="delivery-button" data-order-id="${order.id}" type="button">Invia mappatura</button>
          ${order.delivery_file
            ? `<button class="delivery-download-button" data-order-id="${order.id}" type="button">Scarica copia</button>`
            : ""}
        </div>
      </div>
    `;

    article.innerHTML = `
      <div class="order-card-header">
        <div>
          <span class="panel-kicker">Ordine #${order.id}</span>
          <h3>${order.nome} · ${order.modello}</h3>
        </div>
        <span class="status-pill ${order.stato}">${order.stato}</span>
      </div>

      <div class="order-grid">
        <div class="meta-card"><strong>Cliente</strong><span>${order.username || order.userEmail || "-"}</span></div>
        <div class="meta-card"><strong>Email</strong><span>${order.userEmail || "-"}</span></div>
        <div class="meta-card"><strong>Lettura</strong><span>${order.read_mode}</span></div>
        <div class="meta-card"><strong>Anno</strong><span>${order.anno}</span></div>
        <div class="meta-card"><strong>Motore</strong><span>${order.tipo_motore}</span></div>
        <div class="meta-card"><strong>Centralina</strong><span>${order.marca_centralina}</span></div>
        <div class="meta-card"><strong>KM</strong><span>${order.chilometri}</span></div>
        <div class="meta-card"><strong>Creato</strong><span>${formatDateTime(order.created_at)}</span></div>
        <div class="meta-card"><strong>Approvato</strong><span>${formatDateTime(order.approvato_at)}</span></div>
        <div class="meta-card"><strong>Pagamento</strong><span>${order.pagamento_stato}</span></div>
        <div class="meta-card"><strong>Prezzo</strong><span>${formatCurrency(order.prezzo_lavorazione)}</span></div>
      </div>

      <p class="order-request"><strong>Richiesta:</strong> ${order.richiesta}</p>
      ${order.esito_admin_note ? `<p class="order-note"><strong>Nota admin:</strong> ${order.esito_admin_note}</p>` : ""}
      ${filesMarkup}
      ${deliveryMarkup}

      <button class="detail-button" data-order-id="${order.id}" type="button">Apri richiesta e storico</button>

      <div class="order-actions">
        <div class="order-actions-fields">
          <input type="number" min="0" step="0.01" placeholder="Prezzo lavorazione" id="price-${order.id}" />
          <input type="text" placeholder="Nota admin facoltativa" id="note-${order.id}" />
        </div>
        <div class="order-actions-buttons">
          <button class="decision-button approve" data-order-id="${order.id}" data-decision="approve" type="button">Approva</button>
          <button class="decision-button reject" data-order-id="${order.id}" data-decision="reject" type="button">Rifiuta</button>
        </div>
      </div>
    `;

    ordersList.appendChild(article);
  });
}

async function loadOrders() {
  if (!currentAdminProfile?.isAdmin) {
    allOrders = [];
    renderOrders();
    return;
  }

  setStatus(ordersStatus, "success", "Caricamento ordini...");
  try {
    const snapshot = await withDbFailover((target) => getDocs(collection(target, "orders")));
    allOrders = sortOrders(snapshot.docs.map(mapOrder));
    refreshModelFilter();
    renderOrders();
    setNewOrdersNotice(false);
    setStatus(ordersStatus, "success", `Ordini caricati: ${allOrders.length}`);
  } catch (error) {
    console.error("loadOrders error", error);
    setStatus(ordersStatus, "error", error.message || "Errore caricamento ordini");
  }
}

function startOrdersListener() {
  if (!currentAdminProfile?.isAdmin || ordersUnsubscribe) return;

  let initialized = false;
  ordersUnsubscribe = onSnapshot(collection(currentDb(), "orders"), () => {
    if (initialized) setNewOrdersNotice(true);
    initialized = true;
  }, (error) => {
    console.error("orders listener error", error);
  });
}

function stopOrdersListener() {
  if (!ordersUnsubscribe) return;
  ordersUnsubscribe();
  ordersUnsubscribe = null;
  setNewOrdersNotice(false);
}

async function ensureAdminProfile(user) {
  const profileSnapshot = await withDbFailover((target) => getDoc(doc(target, "users", user.uid)));
  if (!profileSnapshot.exists()) {
    throw new Error("Profilo admin non trovato");
  }

  const profile = profileSnapshot.data();
  if (!profile.isAdmin) {
    throw new Error("Accesso consentito solo agli admin");
  }

  return {
    uid: user.uid,
    email: profile.email || user.email || "",
    username: profile.username || (user.email || "admin").split("@")[0],
    isAdmin: Boolean(profile.isAdmin)
  };
}

function updateSessionUi(isLoggedIn) {
  loginForm.classList.toggle("hidden", isLoggedIn);
  sessionActions.classList.toggle("hidden", !isLoggedIn);
  adminIdentityCard.classList.toggle("hidden", !isLoggedIn);
}

async function createNotification(order, decision, note, price) {
  const notificationId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const payload = decision === "approve"
    ? {
        tipo: "ordine_approvato",
        titolo: `Ordine #${order.id} approvato`,
        messaggio: `${price > 0
          ? `Importo lavorazione: EUR ${price.toFixed(2)}. Procedi al pagamento per ricevere il file modificato.`
          : "Richiesta approvata. Ti contatteremo a breve per i dettagli di consegna del file modificato."}${note ? ` Nota admin: ${note}` : ""}`,
        importo: price > 0 ? price : null,
        pagamento_stato: price > 0 ? "awaiting_payment" : "not_required"
      }
    : {
        tipo: "ordine_rifiutato",
        titolo: `Ordine #${order.id} rifiutato`,
        messaggio: `La richiesta non e stata approvata.${note ? ` Nota admin: ${note}` : ""}`,
        pagamento_stato: "not_required"
      };

  await setDocBoth("notifications", notificationId, {
    id: Number(notificationId),
    userUid: order.userUid,
    email: order.userEmail,
    veicolo_id: order.id,
    letto: false,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    ...payload
  });
}

async function handleDecision(orderId, decision) {
  const order = allOrders.find((entry) => Number(entry.id) === Number(orderId));
  if (!order) {
    setStatus(ordersStatus, "error", "Ordine non trovato");
    return;
  }

  const priceInput = document.getElementById(`price-${orderId}`);
  const noteInput = document.getElementById(`note-${orderId}`);
  const price = Number.parseFloat(priceInput?.value || "");
  const note = String(noteInput?.value || "").trim();
  const hasPrice = Number.isFinite(price) && price > 0;

  setStatus(ordersStatus, "success", `Aggiornamento ordine #${orderId}...`);

  try {
    if (decision === "approve") {
      await updateDocBoth("orders", String(orderId), {
        stato: "approved",
        approvatoAt: serverTimestamp(),
        approvedAtMs: Date.now(),
        pagamento_stato: hasPrice ? "awaiting_payment" : "not_required",
        prezzo_lavorazione: hasPrice ? price : null,
        esito_admin_note: note || null,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now()
      });
      await createNotification(order, "approve", note, hasPrice ? price : 0);
    } else {
      await updateDocBoth("orders", String(orderId), {
        stato: "rejected",
        approvatoAt: null,
        approvedAtMs: null,
        pagamento_stato: "not_required",
        prezzo_lavorazione: null,
        esito_admin_note: note || null,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now()
      });
      await createNotification(order, "reject", note, 0);
    }

    await loadOrders();
    setStatus(ordersStatus, "success", `Ordine #${orderId} aggiornato`);
  } catch (error) {
    console.error("handleDecision error", error);
    setStatus(ordersStatus, "error", error.message || "Errore aggiornamento ordine");
  }
}

async function downloadFile(orderId, fileIndex) {
  const order = allOrders.find((entry) => Number(entry.id) === Number(orderId));
  const file = order?.files?.[fileIndex];
  if (!file?.file_key) {
    setStatus(ordersStatus, "error", "File non disponibile");
    return;
  }

  try {
    const chunksSnapshot = await withDbFailover((target) =>
      getDocs(query(collection(target, "order_file_chunks"), where("fileKey", "==", file.file_key)))
    );
    const orderedBase64 = chunksSnapshot.docs
      .map((docSnapshot) => docSnapshot.data())
      .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
      .map((row) => String(row.data || ""))
      .join("");

    if (!orderedBase64) {
      throw new Error("Contenuto file non disponibile");
    }

    const binaryString = atob(orderedBase64);
    const byteArray = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index += 1) {
      byteArray[index] = binaryString.charCodeAt(index);
    }

    const blob = new Blob([byteArray], { type: file.mime_type || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = file.nome_file || `ordine-${orderId}-${fileIndex}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    console.error("downloadFile error", error);
    setStatus(ordersStatus, "error", error.message || "Errore download file");
  }
}

const DELIVERY_FILE_CHUNK_BASE64_SIZE = 700000;

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lettura file non riuscita"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function triggerBrowserDownload(fileName, mimeType, base64Data) {
  const binaryString = atob(base64Data);
  const byteArray = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    byteArray[index] = binaryString.charCodeAt(index);
  }
  const blob = new Blob([byteArray], { type: mimeType || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

async function downloadDeliveryCopy(orderId) {
  const order = allOrders.find((entry) => Number(entry.id) === Number(orderId));
  const deliveryFile = order?.delivery_file;
  if (!deliveryFile?.file_key) {
    setStatus(ordersStatus, "error", "Nessuna mappatura inviata per questo ordine");
    return;
  }

  try {
    const chunksSnapshot = await withDbFailover((target) =>
      getDocs(query(collection(target, "order_file_chunks"), where("fileKey", "==", deliveryFile.file_key)))
    );
    const orderedBase64 = chunksSnapshot.docs
      .map((docSnapshot) => docSnapshot.data())
      .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
      .map((row) => String(row.data || ""))
      .join("");

    if (!orderedBase64) {
      throw new Error("Contenuto mappatura non disponibile");
    }

    triggerBrowserDownload(deliveryFile.nome_file || `mappatura-ordine-${orderId}`, deliveryFile.mime_type, orderedBase64);
  } catch (error) {
    console.error("downloadDeliveryCopy error", error);
    setStatus(ordersStatus, "error", error.message || "Errore download mappatura");
  }
}

async function sendDeliveryFile(orderId) {
  const order = allOrders.find((entry) => Number(entry.id) === Number(orderId));
  if (!order) {
    setStatus(ordersStatus, "error", "Ordine non trovato");
    return;
  }

  const fileInput = document.getElementById(`delivery-file-${orderId}`);
  const file = fileInput?.files?.[0];
  if (!file) {
    setStatus(ordersStatus, "error", "Seleziona il file della mappatura completata");
    return;
  }

  const sendButton = document.querySelector(`.delivery-button[data-order-id="${orderId}"]`);
  if (sendButton) sendButton.disabled = true;
  setStatus(ordersStatus, "success", `Invio mappatura per ordine #${orderId}...`);

  try {
    const base64Payload = await readFileAsBase64(file);
    const fileId = `${Date.now()}${Math.floor(Math.random() * 100)}`;
    const fileKey = `delivery_${orderId}_${fileId}`;
    const chunkCount = Math.max(1, Math.ceil(base64Payload.length / DELIVERY_FILE_CHUNK_BASE64_SIZE));

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * DELIVERY_FILE_CHUNK_BASE64_SIZE;
      const chunkPayload = {
        fileKey,
        orderId: String(orderId),
        fileId,
        index: chunkIndex,
        totalChunks: chunkCount,
        data: base64Payload.slice(start, start + DELIVERY_FILE_CHUNK_BASE64_SIZE),
        createdAtMs: Date.now()
      };
      await setDocBoth("order_file_chunks", `${fileKey}_${chunkIndex}`, chunkPayload);
    }

    const deliveryFile = {
      id: fileId,
      file_key: fileKey,
      categoria: "mappatura",
      nome_file: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      chunk_count: chunkCount,
      storage_mode: "firestore_chunks"
    };

    const mapDescription = `Mappatura ${[order.nome, order.modello].filter(Boolean).join(" ") || "veicolo"} - ${order.anno || ""} ${order.tipo_motore || ""}`.trim();

    await updateDocBoth("orders", String(orderId), {
      delivery_file: deliveryFile,
      mappa_descrizione: mapDescription,
      consegnatoAt: serverTimestamp(),
      consegnatoAtMs: Date.now(),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now()
    });

    const notificationId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await setDocBoth("notifications", notificationId, {
      id: Number(notificationId),
      userUid: order.userUid,
      email: order.userEmail,
      veicolo_id: order.id,
      tipo: "file_pronto",
      titolo: `Mappatura pronta per ordine #${order.id}`,
      messaggio: `Lavorazione completata. Apri la sezione ordini dell'app per scaricare il file modificato (${file.name}).`,
      pagamento_stato: order.pagamento_stato || "not_required",
      letto: false,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now()
    });

    await loadOrders();
    setStatus(ordersStatus, "success", `Mappatura inviata per ordine #${orderId}: il cliente ricevera una notifica`);
  } catch (error) {
    console.error("sendDeliveryFile error", error);
    setStatus(ordersStatus, "error", error.message || "Errore invio mappatura");
  } finally {
    if (sendButton) sendButton.disabled = false;
  }
}

function describeAuthError(error) {
  const code = String(error?.code || "");
  const rawMessage = String(error?.message || "");
  const mapped = {
    "auth/invalid-email": "Email non valida: controlla il formato (es. nome@dominio.it)",
    "auth/user-not-found": "Nessun account trovato con questa email. Verifica l'indirizzo o crea l'utente su Firebase",
    "auth/wrong-password": "Password errata. Riprova o reimposta la password",
    "auth/invalid-credential": "Credenziali non valide: email o password errate",
    "auth/invalid-login-credentials": "Credenziali non valide: email o password errate",
    "auth/user-disabled": "Questo account e stato disabilitato. Contatta l'amministratore Firebase",
    "auth/too-many-requests": "Troppi tentativi falliti: account temporaneamente bloccato. Riprova tra qualche minuto",
    "auth/network-request-failed": "Errore di rete: impossibile contattare Firebase. Controlla la connessione internet",
    "auth/operation-not-allowed": "Login email/password non abilitato su Firebase: attivalo in Authentication -> Sign-in method",
    "auth/invalid-api-key": "Configurazione Firebase non valida: API key errata in firebase-config.js",
    "auth/internal-error": "Errore interno di Firebase. Riprova tra poco"
  };
  if (mapped[code]) {
    return mapped[code];
  }
  if (code) {
    return `Errore login (${code}): ${rawMessage || "errore sconosciuto"}`;
  }
  return rawMessage || "Login non riuscito";
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(loginStatus, "success", "Accesso in corso...");

  try {
    const credential = await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
    currentAdminProfile = await ensureAdminProfile(credential.user);

    adminAvatar.textContent = getInitials(currentAdminProfile.username || currentAdminProfile.email);
    adminName.textContent = currentAdminProfile.username || "Admin";
    adminEmail.textContent = currentAdminProfile.email || "-";

    updateSessionUi(true);
    setStatus(loginStatus, "", "");
    await loadOrders();
    startOrdersListener();
  } catch (error) {
    console.error("login error", error);
    currentAdminProfile = null;
    updateSessionUi(false);
    setStatus(loginStatus, "error", describeAuthError(error));
    try {
      await signOut(auth);
    } catch (_error) {
    }
  }
});

statusFilter.addEventListener("change", () => {
  renderOrders();
});

modelFilter.addEventListener("change", () => {
  renderOrders();
});

refreshOrdersButton.addEventListener("click", () => {
  loadOrders().catch(() => {});
});

logoutButton.addEventListener("click", async () => {
  stopOrdersListener();
  await signOut(auth);
});

ordersList.addEventListener("click", (event) => {
  const decisionButton = event.target.closest(".decision-button");
  if (decisionButton) {
    handleDecision(decisionButton.dataset.orderId, decisionButton.dataset.decision).catch(() => {});
    return;
  }

  const downloadButton = event.target.closest(".download-button");
  if (downloadButton) {
    downloadFile(downloadButton.dataset.orderId, Number(downloadButton.dataset.fileIndex)).catch(() => {});
    return;
  }

  const deliveryButton = event.target.closest(".delivery-button");
  if (deliveryButton) {
    sendDeliveryFile(deliveryButton.dataset.orderId).catch(() => {});
    return;
  }

  const deliveryDownloadButton = event.target.closest(".delivery-download-button");
  if (deliveryDownloadButton) {
    downloadDeliveryCopy(deliveryDownloadButton.dataset.orderId).catch(() => {});
    return;
  }

  const detailButton = event.target.closest(".detail-button");
  if (detailButton) {
    openOrderDetail(detailButton.dataset.orderId);
  }
});

closeOrderDetailButton.addEventListener("click", closeOrderDetail);
orderDetailModal.addEventListener("click", (event) => {
  if (event.target === orderDetailModal) closeOrderDetail();
});

orderHistoryList.addEventListener("click", (event) => {
  const historyDeliveryButton = event.target.closest(".history-delivery-download");
  if (historyDeliveryButton) {
    downloadDeliveryCopy(historyDeliveryButton.dataset.orderId).catch(() => {});
    return;
  }

  const historyOrderButton = event.target.closest(".history-order-button");
  if (historyOrderButton) openOrderDetail(historyOrderButton.dataset.orderId);
});

selectedOrderDetail.addEventListener("click", (event) => {
  const selectedDeliveryButton = event.target.closest(".history-delivery-download");
  if (selectedDeliveryButton) {
    downloadDeliveryCopy(selectedDeliveryButton.dataset.orderId).catch(() => {});
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOrderDetail();
});

// Ogni 5 minuti prova a tornare sul database primario (la quota si resetta a mezzanotte PT).
window.setInterval(() => {
  tryRestorePrimaryDb().catch(() => {});
}, 5 * 60 * 1000);
updateDbBadge();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentAdminProfile = null;
    allOrders = [];
    renderOrders();
    updateSessionUi(false);
    stopOrdersListener();
    return;
  }

  try {
    currentAdminProfile = await ensureAdminProfile(user);
    adminAvatar.textContent = getInitials(currentAdminProfile.username || currentAdminProfile.email);
    adminName.textContent = currentAdminProfile.username || "Admin";
    adminEmail.textContent = currentAdminProfile.email || "-";
    updateSessionUi(true);
    await loadOrders();
    startOrdersListener();
  } catch (error) {
    setStatus(loginStatus, "error", error.message || "Accesso non consentito");
    await signOut(auth);
  }
});
