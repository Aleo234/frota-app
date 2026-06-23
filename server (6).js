import express from "express";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { readDb, writeDb, readUsers, writeUsers, readEmails, writeEmails } from "./db.js";

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
    const { motorista, placa, tipo, descricao, fotos, bo } = req.body;
    if (!motorista || !placa || !tipo) return res.status(400).json({ error: "Campos obrigatórios: motorista, placa, tipo." });

    const id = randomUUID();
    const criadoEm = Date.now();

    const registro = {
      id, motorista, placa: placa.toUpperCase(), tipo,
      descricao: descricao || "",
      fotos: fotos || [],
      bo: bo || null,
      temFotos: (fotos || []).length,
      temBo: !!bo,
      status: "enviado",
      veiculoSubstituido: null,
      criadoEm,
      enviadoEm: Date.now(),
      respondidoEm: null,
      historico: [
        { status: "pendente", em: criadoEm },
        { status: "enviado", em: Date.now() }
      ],
    };

    const db = await readDb();
    db.push(registro);
    await writeDb(db);

    res.status(201).json(registro);
  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: "Falha ao salvar.", detail: err.message });
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
