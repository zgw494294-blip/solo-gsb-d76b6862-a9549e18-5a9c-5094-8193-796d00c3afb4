"use strict";

let expId = null;
// 当前实验已被显式删除：停止轮询、禁用旧实验操作，绝不自动新建
let deleted = false;
const lastRender = { a: "", b: "" };
let statusTimer = null;
let committedTimer = null;

const $ = (id) => document.getElementById(id);

class ExpGone extends Error {}

async function fetchJson(path, options, forId) {
  const resp = await fetch(path, options);
  if (resp.status === 410 || resp.status === 404) {
    // 仅当响应仍对应当前实验时才改变页面状态；迟到响应一律丢弃，
    // 不得恢复旧展示，也不得在实验被显式删除后自动新建
    if (forId === expId) {
      if (resp.status === 410) {
        // 实验已被删除：停止轮询并禁用旧实验操作
        handleDeleted();
      } else if (!deleted) {
        // 服务端重启后旧实验已不存在：自动新建一个，再通知调用方放弃本次请求
        await newExperiment();
      }
    }
    throw new ExpGone();
  }
  if (!resp.ok) {
    throw new Error("HTTP " + resp.status);
  }
  return resp.json();
}

function startPolling() {
  stopPolling();
  // 状态轮询只读取服务端内存状态，不执行任何 SELECT，不会提前建立快照
  statusTimer = setInterval(() => {
    refreshStatus().catch(() => {});
  }, 2000);
  committedTimer = setInterval(() => {
    refreshCommitted();
  }, 2000);
}

function stopPolling() {
  if (statusTimer !== null) clearInterval(statusTimer);
  if (committedTimer !== null) clearInterval(committedTimer);
  statusTimer = committedTimer = null;
}

function setExperimentControlsEnabled(enabled) {
  // 删除后禁用旧实验的全部操作；「新建实验」按钮始终可用
  for (const el of document.querySelectorAll(
    "#panel-a button, #panel-a input, #panel-b button, #panel-b input," +
      "#ckpt-passive, #ckpt-truncate, #refresh-committed, #delete-exp"
  )) {
    el.disabled = !enabled;
  }
}

function handleDeleted() {
  if (deleted) return;
  deleted = true;
  const oldId = expId;
  expId = null; // 迟到响应据此丢弃，不再渲染旧实验
  stopPolling();
  setExperimentControlsEnabled(false);
  $("exp-id").textContent = oldId ? oldId + "（已删除）" : "已删除";
  $("committed").textContent = "—";
}

async function newExperiment() {
  const resp = await fetch("/api/experiments", { method: "POST" });
  const data = await resp.json();
  expId = data.id;
  deleted = false;
  history.replaceState(null, "", "?exp=" + expId);
  $("exp-id").textContent = expId;
  clearError("a");
  clearError("b");
  clearError("ckpt");
  clearExpError();
  setExperimentControlsEnabled(true);
  await refreshStatus();
  await refreshCommitted();
  startPolling();
}

async function deleteExperiment() {
  const id = expId;
  if (!id || deleted) return;
  if (
    !window.confirm(
      `确定删除当前实验 ${id} 吗？\n` +
        "将回滚未提交事务、关闭全部连接并删除数据库文件（含 WAL / SHM），此操作不可撤销。"
    )
  ) {
    return;
  }
  $("delete-exp").disabled = true;
  clearExpError();
  try {
    const resp = await fetch(`/api/experiments/${id}`, { method: "DELETE" });
    if (resp.ok || resp.status === 410 || resp.status === 404) {
      // 删除成功（或该实验已不存在）：停止轮询并禁用旧实验操作
      if (expId === id) handleDeleted();
    } else {
      showExpError("删除失败：HTTP " + resp.status);
      if (!deleted) $("delete-exp").disabled = false;
    }
  } catch (e) {
    showExpError("删除请求失败：" + e.message);
    if (!deleted) $("delete-exp").disabled = false;
  }
}

async function refreshStatus() {
  const id = expId;
  if (!id) return;
  const data = await fetchJson(`/api/experiments/${id}/status`, undefined, id);
  if (expId !== id) return; // 迟到响应：实验已删除或已切换，丢弃
  renderPanel("a", data.a);
  renderPanel("b", data.b);
  renderCheckpoint(data.checkpoint);
}

async function refreshCommitted() {
  const id = expId;
  if (!id) return;
  try {
    const data = await fetchJson(
      `/api/experiments/${id}/committed`,
      undefined,
      id
    );
    if (expId !== id) return; // 迟到响应：不恢复旧展示
    $("committed").textContent = data.committed;
  } catch (e) {
    if (!(e instanceof ExpGone)) {
      // 忽略瞬时错误，下一轮轮询会恢复
    }
  }
}

function renderPanel(side, state) {
  const key = JSON.stringify(state);
  if (lastRender[side] === key) return;
  lastRender[side] = key;

  const inTx = state.in_transaction;
  $("tx-" + side).textContent = inTx ? "已开启" : "未开启";
  const dot = $("dot-" + side);
  dot.classList.toggle("on", inTx);
  dot.title = inTx ? "事务已开启" : "事务未开启";
  $("read-" + side).textContent = state.last_read === null ? "—" : state.last_read;

  const logEl = $("log-" + side);
  logEl.innerHTML = "";
  for (const entry of state.log) {
    const li = document.createElement("li");
    li.textContent = entry;
    if (entry.includes("→ 失败") || entry.includes("→ 拒绝")) {
      li.classList.add("log-error");
    }
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function renderCheckpoint(state) {
  // 只渲染服务端内存中的最近结果缓存：轮询本身不触发检查点
  const resultEl = $("ckpt-result");
  const last = state && state.last;
  if (!last) {
    resultEl.textContent = "尚未执行过检查点";
    resultEl.classList.remove("busy");
  } else {
    resultEl.textContent =
      `最近一次 ${last.mode}：busy=${last.busy}，` +
      `WAL 总帧数=${last.log_frames}，已回写帧数=${last.checkpointed}，` +
      `WAL 文件大小=${last.wal_size} 字节`;
    resultEl.classList.toggle("busy", last.busy === 1);
  }

  const logEl = $("log-ckpt");
  logEl.innerHTML = "";
  for (const entry of (state && state.log) || []) {
    const li = document.createElement("li");
    li.textContent = entry;
    if (entry.includes("失败") || entry.includes("busy=1")) {
      li.classList.add("log-error");
    }
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(side, busy) {
  // 只禁用本栏的按钮与输入框，另一栏不受影响
  for (const el of document.querySelectorAll(
    `#panel-${side} button, #panel-${side} input`
  )) {
    el.disabled = busy;
  }
}

function showError(side, error) {
  const box = $("error-" + side);
  box.textContent = error.name
    ? `${error.name}（错误码 ${error.code}）：${error.message}`
    : error.message;
  box.hidden = false;
}

function clearError(side) {
  $("error-" + side).hidden = true;
}

function showExpError(message) {
  const box = $("exp-error");
  box.textContent = message;
  box.hidden = false;
}

function clearExpError() {
  $("exp-error").hidden = true;
}

async function doOp(side, op) {
  const id = expId;
  if (!id) return;
  const body = { op };
  if (op === "add") {
    const raw = $(`add-input-${side}`).value.trim();
    if (!/^[+-]?\d+$/.test(raw)) {
      showError(side, { name: null, code: null, message: "请输入一个整数" });
      return;
    }
    // 大整数以十进制字符串传输避免精度丢失；安全整数范围内仍发送数字
    const big = BigInt(raw);
    body.value =
      big >= BigInt(Number.MIN_SAFE_INTEGER) &&
      big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big.toString();
  }
  setBusy(side, true);
  clearError(side);
  try {
    const data = await fetchJson(
      `/api/experiments/${id}/conn/${side}/op`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      id
    );
    if (expId !== id) return; // 迟到响应不得恢复旧展示
    renderPanel(side, data.state);
    if (!data.ok && data.error) {
      showError(side, data.error);
    }
    refreshCommitted();
  } catch (e) {
    if (!(e instanceof ExpGone) && expId === id) {
      showError(side, { name: null, code: null, message: "请求失败：" + e.message });
    }
  } finally {
    if (!deleted) setBusy(side, false);
  }
}

function bindPanel(side) {
  for (const btn of document.querySelectorAll(`#panel-${side} button[data-op]`)) {
    btn.addEventListener("click", () => doOp(side, btn.dataset.op));
  }
}

function setCheckpointBusy(busy) {
  // 检查点请求进行中只禁用检查点按钮，甲、乙两栏照常可用
  $("ckpt-passive").disabled = busy;
  $("ckpt-truncate").disabled = busy;
}

async function doCheckpoint(mode) {
  const id = expId;
  if (!id) return;
  setCheckpointBusy(true);
  clearError("ckpt");
  try {
    const data = await fetchJson(
      `/api/experiments/${id}/checkpoint/${mode}`,
      { method: "POST" },
      id
    );
    if (expId !== id) return; // 迟到响应不得恢复旧展示
    renderCheckpoint(data.state);
    if (!data.ok && data.error) {
      showError("ckpt", data.error);
    }
  } catch (e) {
    if (!(e instanceof ExpGone) && expId === id) {
      showError("ckpt", { name: null, code: null, message: "请求失败：" + e.message });
    }
  } finally {
    if (!deleted) setCheckpointBusy(false);
  }
}

async function init() {
  bindPanel("a");
  bindPanel("b");
  $("new-exp").addEventListener("click", () => {
    newExperiment().catch(() => {});
  });
  $("delete-exp").addEventListener("click", () => {
    deleteExperiment().catch(() => {});
  });
  $("refresh-committed").addEventListener("click", () => {
    refreshCommitted();
  });
  $("ckpt-passive").addEventListener("click", () => {
    doCheckpoint("PASSIVE").catch(() => {});
  });
  $("ckpt-truncate").addEventListener("click", () => {
    doCheckpoint("TRUNCATE").catch(() => {});
  });

  const params = new URLSearchParams(location.search);
  const existing = params.get("exp");
  if (existing) {
    expId = existing;
    $("exp-id").textContent = existing;
    try {
      await refreshStatus();
      await refreshCommitted();
    } catch (e) {
      // 404 时 fetchJson 已自动新建实验；410 时已按「已删除」处理
    }
    if (!deleted && expId) startPolling();
  } else {
    await newExperiment();
  }
}

init();
