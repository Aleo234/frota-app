import express from "express";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { readDb, upsertSolicitacao, updateSolicitacao, readUsers, writeUsers, upsertUser, findUser, readEmails, writeEmails, connect } from "./db.js";

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

// ---------- Healthcheck ----------
app.get("/", (req, res) => res.json({ status: "ok", service: "frota-conecta-backend" }));

// ---------- USUÁRIOS ----------
app.get("/api/usuarios", checkApiKey, async (req, res) => {
  const users = await readUsers();
  res.json(users.map(({ _id, pinHash, ...u }) => u));
});

app.post("/api/usuarios", checkApiKey, async (req, res) => {
  const { id, role, nome, usuario, pinHash, criadoEm, aprovado } = req.body;
  if (!id || !role || !pinHash) return res.status(400).json({ error: "Dados inválidos." });

  if (role === "motorista") {
    const existe = await findUser({ role: "motorista", nome: { $regex: new RegExp(`^${nome.trim()}$`, "i") } });
    if (existe) return res.status(409).json({ error: "Motorista já cadastrado." });
  }
  if (role === "atendimento") {
    const existe = await findUser({ role: "atendimento", nome: { $regex: new RegExp(`^${nome.trim()}$`, "i") } });
    if (existe) return res.status(409).json({ error: "Usuário já cadastrado." });
  }
  if (role === "gestor") {
    const existe = await findUser({ role: "gestor", usuario: { $regex: new RegExp(`^${usuario.trim()}$`, "i") } });
    if (existe) return res.status(409).json({ error: "Usuário já cadastrado." });
  }

  const novoUser = { id, role, nome, usuario, pinHash, criadoEm, aprovado: aprovado===false?false:true };
  await upsertUser(novoUser);
  const { pinHash: _, ...semHash } = novoUser;
  res.status(201).json(semHash);
});

app.post("/api/usuarios/login", checkApiKey, async (req, res) => {
  const { role, nome, usuario, pinHash } = req.body;
  let user = null;
  try {
    if (role === "motorista") {
      if (!nome) return res.status(400).json({ error: "Nome obrigatório." });
      user = await findUser({ role: "motorista", nome: { $regex: new RegExp(`^${nome.trim()}$`, "i") }, pinHash });
    } else if (role === "atendimento") {
      if (!nome) return res.status(400).json({ error: "Nome obrigatório." });
      user = await findUser({ role: "atendimento", nome: { $regex: new RegExp(`^${nome.trim()}$`, "i") }, pinHash });
    } else {
      if (!usuario) return res.status(400).json({ error: "Usuário obrigatório." });
      user = await findUser({ role: "gestor", usuario: { $regex: new RegExp(`^${usuario.trim()}$`, "i") }, pinHash });
    }
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
  if (!user) return res.status(401).json({ error: "Credenciais inválidas." });
  const { _id, pinHash: _, ...semHash } = user;
  res.json(semHash);
});

// ---------- PATCH USUÁRIO (ativar/desativar) ----------
app.patch("/api/usuarios/:id", checkApiKey, async (req, res) => {
  const { id } = req.params;
  const { ativo, aprovado, pinHash } = req.body;
  try {
    const d = await connect();
    const patch = {};
    if (typeof ativo === "boolean") patch.ativo = ativo;
    if (typeof aprovado === "boolean") patch.aprovado = aprovado;
    if (pinHash) patch.pinHash = pinHash;
    await d.collection("usuarios").updateOne({id}, {$set: patch});
    const updated = await d.collection("usuarios").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id, pinHash:_, ...semHash} = updated;
    res.json(semHash);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/usuarios/:id", checkApiKey, async (req, res) => {
  const { id } = req.params;
  try {
    const d = await connect();
    const result = await d.collection("usuarios").deleteOne({ id });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Usuário não encontrado." });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { motorista, placa, tipo, descricao, fotos, bo, urgencia, km } = req.body;
    if (!motorista || !placa || !tipo) return res.status(400).json({ error: "Campos obrigatórios: motorista, placa, tipo." });

    const id = randomUUID();
    const criadoEm = Date.now();

    const registro = {
      id, motorista, placa: placa.toUpperCase(), tipo,
      descricao: descricao || "",
      urgencia: urgencia || "normal",
      km: km || null,
      fotos: fotos || [],
      bo: bo || null,
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

    await upsertSolicitacao(registro);
    res.status(201).json(registro);
  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: "Falha ao salvar.", detail: err.message });
  }
});

app.get("/api/solicitacoes", checkApiKey, async (req, res) => {
  const db = await readDb();
  res.json(db.map(({ _id, ...r }) => r));
});

app.patch("/api/solicitacoes/:id", checkApiKey, async (req, res) => {
  const { id } = req.params;
  const { status, veiculoSubstituido, placaSubstituta } = req.body;
  const statusValidos = ["pendente","enviado","andamento","concluido","cancelado"];

  const patch = {};
  if (status) {
    patch.status = status;
    if (status !== "enviado") patch.respondidoEm = Date.now();
  }
  if (typeof veiculoSubstituido === "boolean") patch.veiculoSubstituido = veiculoSubstituido;
  if (placaSubstituta !== undefined) patch.placaSubstituta = placaSubstituta;

  const rec = await updateSolicitacao(id, patch);
  if (!rec) return res.status(404).json({ error: "Não encontrado." });
  const { _id, ...r } = rec;
  res.json(r);
});

app.get("/api/relatorios/sinistros", checkApiKey, async (req, res) => {
  const db = await readDb();
  res.json(db.filter(r => r.tipo === "sinistro").map(({ _id, ...r }) => r));
});

// ---------- CHECKLIST ITEMS ----------
app.get("/api/checklist-items", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const items = await d.collection("checklist_items").find().sort({criadoEm:1}).toArray();
    res.json(items.map(({_id,...i})=>i));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/checklist-items", checkApiKey, async (req, res) => {
  try {
    const items = req.body;
    if(!Array.isArray(items)) return res.status(400).json({error:"Lista inválida."});
    const d = await connect();
    await d.collection("checklist_items").deleteMany({});
    if(items.length) await d.collection("checklist_items").insertMany(items);
    res.json(items);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- CHECKLISTS ENVIADOS ----------
app.get("/api/checklists", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const cls = await d.collection("checklists").find().sort({criadoEm:-1}).toArray();
    res.json(cls.map(({_id,...c})=>c));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/checklists", checkApiKey, async (req, res) => {
  try {
    const cl = req.body;
    if(!cl.id) return res.status(400).json({error:"Checklist inválido."});
    const d = await connect();
    await d.collection("checklists").insertOne(cl);
    const {_id,...r} = cl;
    res.status(201).json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/checklists/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    await d.collection("checklists").updateOne({id}, {$set: req.body});
    const updated = await d.collection("checklists").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id,...r} = updated;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- ATENDIMENTOS ----------
app.get("/api/atendimentos", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const items = await d.collection("atendimentos").find().sort({criadoEm:-1}).toArray();
    res.json(items.map(({_id,...i})=>i));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/atendimentos", checkApiKey, async (req, res) => {
  try {
    const at = req.body;
    if(!at.id) return res.status(400).json({error:"Dados inválidos."});
    const d = await connect();
    await d.collection("atendimentos").insertOne(at);
    const {_id,...r} = at;
    res.status(201).json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/atendimentos/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const patch = req.body;
    const d = await connect();
    await d.collection("atendimentos").updateOne({id}, {$set: patch});
    const updated = await d.collection("atendimentos").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id,...r} = updated;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- SAÍDAS DE ATENDIMENTO ----------
app.get("/api/saidas", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const items = await d.collection("saidas").find().sort({criadoEm:-1}).toArray();
    res.json(items.map(({_id,...i})=>i));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/saidas", checkApiKey, async (req, res) => {
  try {
    const s = req.body;
    if(!s.id) return res.status(400).json({error:"Dados inválidos."});
    const d = await connect();
    await d.collection("saidas").insertOne(s);
    const {_id,...r} = s;
    res.status(201).json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/saidas/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    await d.collection("saidas").updateOne({id}, {$set: req.body});
    const updated = await d.collection("saidas").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id,...r} = updated;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- VEÍCULOS DA FROTA ----------
app.get("/api/veiculos", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const items = await d.collection("veiculos").find().sort({criadoEm:-1}).toArray();
    res.json(items.map(({_id,...i})=>i));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/veiculos", checkApiKey, async (req, res) => {
  try {
    const v = req.body;
    if(!v.id||!v.placa||!v.modelo) return res.status(400).json({error:"Dados inválidos."});
    const d = await connect();
    await d.collection("veiculos").insertOne(v);
    const {_id,...r} = v;
    res.status(201).json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/veiculos/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    await d.collection("veiculos").updateOne({id}, {$set: req.body});
    const updated = await d.collection("veiculos").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id,...r} = updated;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/veiculos/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    const result = await d.collection("veiculos").deleteOne({id});
    if(result.deletedCount===0) return res.status(404).json({error:"Não encontrado."});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- CAUTELA VEICULAR ----------
app.get("/api/cautelas", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const items = await d.collection("cautelas").find().sort({criadoEm:-1}).toArray();
    res.json(items.map(({_id,...i})=>i));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/cautelas", checkApiKey, async (req, res) => {
  try {
    const c = req.body;
    if(!c.id||!c.tipo||!c.veiculo?.placa) return res.status(400).json({error:"Dados inválidos."});
    const d = await connect();
    await d.collection("cautelas").insertOne(c);
    const {_id,...r} = c;
    res.status(201).json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/cautelas/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    await d.collection("cautelas").updateOne({id}, {$set: req.body});
    const updated = await d.collection("cautelas").findOne({id});
    if(!updated) return res.status(404).json({error:"Não encontrado."});
    const {_id,...r} = updated;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete("/api/cautelas/:id", checkApiKey, async (req, res) => {
  try {
    const {id} = req.params;
    const d = await connect();
    const result = await d.collection("cautelas").deleteOne({id});
    if(result.deletedCount===0) return res.status(404).json({error:"Não encontrado."});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- CONFIGURAÇÃO PADRÃO DA CAUTELA (Secretário Geral / Diretor de Transporte) ----------
app.get("/api/config-cautela", checkApiKey, async (req, res) => {
  try {
    const d = await connect();
    const cfg = await d.collection("config_cautela").findOne({_key:"default"});
    if(!cfg) return res.json({});
    const {_id,...r} = cfg;
    res.json(r);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.patch("/api/config-cautela", checkApiKey, async (req, res) => {
  try {
    const cfg = { ...req.body, _key: "default" };
    const d = await connect();
    await d.collection("config_cautela").updateOne({_key:"default"}, {$set: cfg}, {upsert:true});
    res.json(cfg);
  } catch(e){ res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Frota Conecta backend na porta ${PORT}`));
