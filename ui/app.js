const state = { token: sessionStorage.getItem("gmx-api-token") || "", accounts: [], selectedAccount: null, messages: [] };
const $ = (selector, root = document) => root.querySelector(selector);
const tokenInput = $("#api-token");
const accountNoteInput = $("#account-note");
const accountEmailInput = $("#account-email-input");
const accountPasswordInput = $("#account-password-input");
tokenInput.value = state.token;

function setConnectionStatus(text, kind = "") { const status = $("#connection-status"); status.textContent = text; status.className = `status ${kind}`; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "尚未收件"; }
async function api(path, options = {}) {
  if (!state.token) throw new Error("请先填入本地 API 令牌并连接。");
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) { const error = payload?.error || {}; throw new Error(`${error.message || "本地服务请求失败。"}${error.detail ? `\n诊断：${error.detail}` : ""}`); }
  return payload;
}

function setView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("hidden", view.id !== `${name}-view`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  const mailboxMenu = $("#mailbox-menu");
  const mailboxButton = $("#mailboxes-menu-button");
  const mailboxOpen = name === "mailboxes";
  mailboxMenu.classList.toggle("hidden", !mailboxOpen);
  mailboxButton.setAttribute("aria-expanded", String(mailboxOpen));
  if (name === "mailboxes" && state.token) loadAccounts().catch((error) => setConnectionStatus(error.message, "error"));
}

async function loadAccounts() {
  const result = await api("/api/accounts");
  state.accounts = result.accounts;
  if (state.selectedAccount) state.selectedAccount = state.accounts.find((account) => account.id === state.selectedAccount.id) || null;
  renderAccounts();
  if (state.selectedAccount) selectAccount(state.selectedAccount, false);
  setConnectionStatus(`已连接 · ${state.accounts.length} 个账号`, "success");
}

function renderAccounts() {
  const list = $("#accounts-list"); list.replaceChildren();
  $("#accounts-empty").hidden = state.accounts.length > 0;
  $("#account-count").textContent = state.accounts.length || "";
  for (const account of state.accounts) {
    const element = $("#account-template").content.firstElementChild.cloneNode(true);
    element.classList.toggle("selected", state.selectedAccount?.id === account.id);
    $(".account-avatar", element).textContent = account.email[0].toUpperCase();
    $(".account-email", element).textContent = account.email;
    $(".last-fetch", element).textContent = account.note || (account.lastFetchAt ? `上次收件 · ${formatDate(account.lastFetchAt)}` : "尚未收件");
    $(".account-state", element).textContent = account.enabled ? "启用" : "停用";
    $(".account-state", element).classList.toggle("disabled", !account.enabled);
    element.addEventListener("click", () => selectAccount(account)); list.append(element);
  }
}

async function selectAccount(account, shouldRender = true) {
  state.selectedAccount = account;
  state.messages = [];
  $("#mailbox-title").textContent = account.email;
  $("#mailbox-subtitle").textContent = account.enabled ? "已打开邮箱 · 邮件内容保存在本地" : "此账号已停用，无法收取新邮件。";
  accountNoteInput.disabled = false;
  accountNoteInput.value = account.note || "";
  setNoteStatus("");
  $("#fetch-button").disabled = !account.enabled;
  $("#renew-session-button").disabled = false;
  if (shouldRender) renderAccounts();
  renderMessages();
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(account.id)}/messages`);
    if (state.selectedAccount?.id !== account.id) return;
    state.messages = result.messages;
    renderMessages();
  } catch (error) {
    if (state.selectedAccount?.id === account.id) $("#messages-empty").textContent = error.message;
  }
}

function renderMessages() {
  const list = $("#message-list"); const detail = $("#message-detail"); list.replaceChildren();
  $("#mail-count").textContent = state.messages.length || "";
  $("#messages-empty").hidden = state.messages.length > 0;
  detail.className = "message-detail empty"; detail.textContent = state.selectedAccount ? "从邮件列表选择一封邮件，即可在这里阅读富文本内容。" : "从左侧选择一个邮箱以查看邮件。";
  state.messages.forEach((message) => {
    const button = document.createElement("button"); button.className = "message-item"; button.type = "button";
    const subject = document.createElement("strong"); subject.textContent = message.skipped ? "邮件过大，未解析" : (message.headers.subject || "（无主题）");
    const from = document.createElement("span"); from.textContent = message.skipped ? `${message.size} bytes` : (message.headers.from || "未知发件人");
    const date = document.createElement("time"); date.textContent = message.skipped ? message.reason : formatDate(message.headers.date);
    button.append(subject, from, date); button.addEventListener("click", () => showMessage(message, button)); list.append(button);
  });
}

function showMessage(message, selectedButton) {
  document.querySelectorAll(".message-item.selected").forEach((item) => item.classList.remove("selected")); selectedButton.classList.add("selected");
  const detail = $("#message-detail"); detail.className = "message-detail"; detail.replaceChildren();
  if (message.skipped) { detail.textContent = `此邮件大小为 ${message.size} bytes，超过本地返回限制，因此未解析。收件出口：${message.egress ? `${message.egress.proxyHost}:${message.egress.proxyPort} · Session ${message.egress.sessionId}` : "历史邮件未记录出口信息"}`; return; }
  const header = document.createElement("header"); header.className = "mail-header";
  const title = document.createElement("h3"); title.textContent = message.headers.subject || "（无主题）";
  const meta = document.createElement("div"); meta.className = "mail-meta";
  const egress = message.egress
    ? `${message.egress.proxyHost}:${message.egress.proxyPort} · Session ${message.egress.sessionId}`
    : "历史邮件未记录出口信息";
  [["发件人", message.headers.from || "未知"], ["收件人", message.headers.to || "未知"], ["时间", formatDate(message.headers.date)], ["收件出口", egress]].forEach(([label, value]) => { const line = document.createElement("p"); line.textContent = `${label}：${value}`; meta.append(line); });
  header.append(title, meta); detail.append(header);
  if (message.body.html) {
    const frame = document.createElement("iframe"); frame.className = "html-body"; frame.title = "邮件富文本正文"; frame.sandbox = "";
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank">${message.body.html}`;
    detail.append(frame);
  } else { const body = document.createElement("div"); body.className = "plain-body"; body.textContent = message.body.text || "（该邮件没有可显示的正文）"; detail.append(body); }
}

async function fetchMessages() {
  const account = state.selectedAccount; if (!account) return;
  const button = $("#fetch-button"); button.disabled = true; button.textContent = "正在收件…";
  try { await api(`/api/accounts/${encodeURIComponent(account.id)}/fetch`, { method: "POST", body: JSON.stringify({ limit: 10 }) }); await loadAccounts(); }
  catch (error) { alert(error.message); }
  finally { button.disabled = !state.selectedAccount?.enabled; button.textContent = "收取邮件"; }
}
async function renewSession() { const account = state.selectedAccount; if (!account || !confirm(`确定为 ${account.email} 更换代理出口吗？`)) return; try { await api(`/api/accounts/${encodeURIComponent(account.id)}/renew-session`, { method: "POST" }); await loadAccounts(); } catch (error) { alert(error.message); } }

function setNoteStatus(text, kind = "") { const status = $("#account-note-status"); status.textContent = text; status.className = `note-status ${kind}`; }
async function saveAccountNote() {
  const account = state.selectedAccount;
  if (!account || accountNoteInput.disabled) return;
  const note = accountNoteInput.value.trim();
  if (note === (account.note || "")) return;
  const accountId = account.id;
  accountNoteInput.disabled = true;
  setNoteStatus("正在保存…");
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/note`, { method: "PUT", body: JSON.stringify({ note }) });
    const updated = result.account;
    const index = state.accounts.findIndex((item) => item.id === accountId);
    if (index >= 0) state.accounts[index] = updated;
    if (state.selectedAccount?.id === accountId) {
      state.selectedAccount = updated;
      accountNoteInput.value = updated.note;
      setNoteStatus("已保存", "success");
      renderAccounts();
    }
  } catch (error) {
    setNoteStatus(`保存失败：${error.message}`, "error");
  } finally {
    if (state.selectedAccount?.id === accountId) accountNoteInput.disabled = false;
  }
}

$("#connect-button").addEventListener("click", async () => { state.token = tokenInput.value.trim(); sessionStorage.setItem("gmx-api-token", state.token); try { await loadAccounts(); } catch (error) { sessionStorage.removeItem("gmx-api-token"); setConnectionStatus(error.message, "error"); } });
$("#refresh-button").addEventListener("click", () => loadAccounts().catch((error) => setConnectionStatus(error.message, "error")));
$("#fetch-button").addEventListener("click", fetchMessages); $("#renew-session-button").addEventListener("click", renewSession);
accountNoteInput.addEventListener("blur", saveAccountNote);
$("#add-account-button").addEventListener("click", async () => {
  const message = $("#add-account-result");
  const email = accountEmailInput.value.trim();
  const password = accountPasswordInput.value;
  if (!email || !password) {
    message.textContent = "请填写 GMX 邮箱和 IMAP 密码。";
    message.className = "form-message error";
    return;
  }
  try {
    const result = await api("/api/accounts/import", { method: "POST", body: JSON.stringify({ accounts: [{ email, password }] }) });
    if (result.imported.length) {
      message.textContent = `已添加 ${result.imported[0].email}。`;
      message.className = "form-message success";
      accountEmailInput.value = "";
      accountPasswordInput.value = "";
      await loadAccounts();
    } else {
      const reason = result.skipped[0]?.reason;
      message.textContent = reason === "ALREADY_IMPORTED" ? "该邮箱已添加。" : "邮箱格式或 IMAP 密码无效。";
      message.className = "form-message error";
    }
  } catch (error) {
    message.textContent = error.message;
    message.className = "form-message error";
  }
});
$("#import-button").addEventListener("click", async () => {
  const accounts = $("#import-input").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.includes("----") ? "----" : "|";
    const index = line.indexOf(separator);
    return index < 1 ? null : { email: line.slice(0, index).trim(), password: line.slice(index + separator.length).trim() };
  });
  const message = $("#import-result");
  if (!accounts.length || accounts.some((account) => !account || !account.password)) {
    message.textContent = "格式错误：每行必须是“邮箱----IMAP 密码”（也兼容“邮箱 | IMAP 密码”）。";
    message.className = "form-message error";
    return;
  }
  try {
    const result = await api("/api/accounts/import", { method: "POST", body: JSON.stringify({ accounts }) });
    message.textContent = `已导入 ${result.imported.length} 个账号；跳过 ${result.skipped.length} 个。`;
    message.className = "form-message success";
    $("#import-input").value = "";
    await loadAccounts();
  } catch (error) {
    message.textContent = error.message;
    message.className = "form-message error";
  }
});
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
if (state.token) loadAccounts().catch((error) => setConnectionStatus(error.message, "error"));
