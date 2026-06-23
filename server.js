import express from "express";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { readDb, writeDb, readUsers, writeUsers, readEmails, writeEmails } from "./db.js";
import { gerarHtmlRelatorio } from "./pdf.js";

dotenv.config();

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "25mb" }));

function checkApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "API key inválida." });
  }
  next();
}

const TIPOS_LABEL = {
  revisao: "Revisão", pneu: "Troca de pneu", parabrisa: "Troca de parabrisa",
  oleo: "Troca de óleo", sinistro: "Sinistro / Acidente", outro: "Outro",
};

function dataUrlToBase64(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

// Envio via API HTTP do Brevo (sem SMTP, sem bloqueio de porta)
async function enviarEmail({ destinatarios, subject, text, htmlRelatorio, fotos, bo, placa, id }) {
  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) throw new Error("BREVO_API_KEY não configurada.");

  const attachments = [];

  // Relatório HTML
  attachments.push({
    name: `solicitacao-${placa}-${id.slice(0,6)}.html`,
    content: Buffer.from(htmlRelatorio, "utf-8").toString("base64"),
  });

  // Fotos
  (fotos || []).forEach((dataUrl, i) => {
    const p = dataUrlToBase64(dataUrl);
    if (p) attachments.push({ name: `foto-${i+1}-${placa}.jpg`, content: p.base64 });
  });

  // Boletim
  if (bo?.dataUrl) {
    const p = dataUrlToBase64(bo.dataUrl);
    if (p) attachments.push({ name: bo.name || `boletim-${placa}`, content: p.base64 });
  }

  const body = {
    sender: { name: "Frota Conecta", email: process.env.SENDER_EMAIL || "noreply@frotaconecta.com" },
    to: destinatarios.map(e => ({ email: e })),
    subject,
    textContent: text,
    attachment: attachments,
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": BREVO_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Brevo API erro ${res.status}`);
  }
  return res.json();
}

// ---------- Healthcheck ----------
app.get("/", (req, res) => res.json({ status: "ok", service: "frota-conecta-backend" }));

// ---------- USUÁRIOS ----------
app.get("/api/usuarios", checkApiKey, async (req, res) => {
  const users = await readUsers();
  res.json(users.map(({ pinHash, ...u }) => u));
});

app.post("/api/usuarios", checkApiKey, async (req, res) => {
  const { id, role, nome, usuario, pinHash, criadoEm } = req.body;
  if (!id || !role || !pinHash) return res.status(400).json({ error: "Dados inválidos." });
  const users = await readUsers();
  if (role === "motorista") {
    const existe = users.find(u => u.role === "motorista" && u.nome?.trim().toLowerCase() === nome?.trim().toLowerCase());
    if (existe) return res.status(409).json({ error: "Motorista já cadastrado." });
  }
  if (role === "gestor") {
    const existe = users.find(u => u.role === "gestor" && u.usuario?.trim().toLowerCase() === usuario?.trim().toLowerCase());
    if (existe) return res.status(409).json({ error: "Usuário já cadastrado." });
  }
  const novoUser = { id, role, nome, usuario, pinHash, criadoEm };
  users.push(novoUser);
  await writeUsers(users);
  const { pinHash: _, ...semHash } = novoUser;
  res.status(201).json(semHash);
});

app.post("/api/usuarios/login", checkApiKey, async (req, res) => {
  const { role, nome, usuario, pinHash } = req.body;
  const users = await readUsers();
  let user = null;
  if (role === "motorista") {
    user = users.find(u => u.role === "motorista" && u.nome?.trim().toLowerCase() === nome?.trim().toLowerCase() && u.pinHash === pinHash);
  } else {
    user = users.find(u => u.role === "gestor" && u.usuario?.trim().toLowerCase() === usuario?.trim().toLowerCase() && u.pinHash === pinHash);
  }
  if (!user) return res.status(401).json({ error: "Credenciais inválidas." });
  const { pinHash: _, ...semHash } = user;
  res.json(semHash);
});

// ---------- E-MAILS ----------
app.get("/api/emails", checkApiKey, async (req, res) => res.json(await readEmails()));
app.post("/api/emails", checkApiKey, async (req, res) => {
  const lista = req.body;
  if (!Array.isArray(lista)) return res.status(400).json({ error: "Lista inválida." });
  await writeEmails(lista);
  res.json(lista);
});

// ---------- SOLICITAÇÕES ----------
app.post("/api/solicitacoes", checkApiKey, async (req, res) => {
  try {
    const { motorista, placa, tipo, descricao, fotos, bo, destinatarios: destFrontend } = req.body;
    if (!motorista || !placa || !tipo) return res.status(400).json({ error: "Campos obrigatórios: motorista, placa, tipo." });

    const id = randomUUID();
    const criadoEm = Date.now();
    const tipoLabel = TIPOS_LABEL[tipo] || tipo;

    const destEnv = (process.env.DEST_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);
    const destApp = Array.isArray(destFrontend) ? destFrontend.filter(Boolean) : [];
    const destinatarios = [...new Set([...destEnv, ...destApp])];

    if (destinatarios.length === 0) return res.status(500).json({ error: "Nenhum e-mail destinatário configurado." });

    const registro = {
      id, motorista, placa: placa.toUpperCase(), tipo, descricao: descricao || "",
      temFotos: (fotos || []).length, temBo: !!bo,
      status: "enviado", veiculoSubstituido: null,
      criadoEm, enviadoEm: null, respondidoEm: null,
      historico: [{ status: "pendente", em: criadoEm }, { status: "enviado", em: Date.now() }],
    };

    const htmlRelatorio = gerarHtmlRelatorio({ ...registro, fotos: fotos || [], bo });
    const subject = `[Manutenção] ${tipoLabel} — Placa ${placa} — ${motorista}`;
    const text = `Motorista: ${motorista}\nPlaca: ${placa}\nTipo: ${tipoLabel}\nDescrição: ${descricao || "(sem descrição)"}\n\nRelatório completo em anexo.`;

    await enviarEmail({ destinatarios, subject, text, htmlRelatorio, fotos, bo, placa, id });

    registro.enviadoEm = Date.now();
    const db = await readDb();
    db.push(registro);
    await writeDb(db);

    res.status(201).json({ ...registro, destinatarios });
  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: "Falha ao enviar.", detail: err.message });
  }
});

app.get("/api/solicitacoes", checkApiKey, async (req, res) => {
  const db = await readDb();
  res.json(db.sort((a, b) => b.criadoEm - a.criadoEm));
});

app.patch("/api/solicitacoes/:id", checkApiKey, async (req, res) => {
  const { id } = req.params;
  const { status, veiculoSubstituido, placaSubstituta } = req.body;
  const db = await readDb();
  const idx = db.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: "Não encontrado." });
  const rec = db[idx];
  if (status && status !== rec.status) {
    rec.status = status;
    rec.historico.push({ status, em: Date.now() });
    if (!rec.respondidoEm && status !== "enviado") rec.respondidoEm = Date.now();
  }
  if (typeof veiculoSubstituido === "boolean") rec.veiculoSubstituido = veiculoSubstituido;
  if (placaSubstituta !== undefined) rec.placaSubstituta = placaSubstituta;
  db[idx] = rec;
  await writeDb(db);
  res.json(rec);
});

app.get("/api/relatorios/sinistros", checkApiKey, async (req, res) => {
  const db = await readDb();
  res.json(db.filter(r => r.tipo === "sinistro"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Frota Conecta backend na porta ${PORT}`));
