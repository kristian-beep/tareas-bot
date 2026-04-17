// server.js — Bot de tareas con MongoDB, horarios, keep-alive y recordatorios
// npm install express twilio dotenv mongoose node-cron

import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cron from "node-cron";
import https from "https";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
const { MessagingResponse } = twilio.twiml;

// ─── Conexión a MongoDB ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.error("Error MongoDB:", err));

// ─── Esquema de tareas ────────────────────────────────────────────────────────
const taskSchema = new mongoose.Schema({
  phone:    { type: String, required: true },
  title:    { type: String, required: true },
  due:      { type: String },
  hora:     { type: String, default: "" },
  priority: { type: String, default: "media" },
  status:   { type: String, default: "pendiente" },
  cliente:  { type: String, default: "" },
  created:  { type: Date, default: Date.now },
});
const Task = mongoose.model("Task", taskSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDueDate(rawDate) {
  let due = new Date();
  due.setDate(due.getDate() + 3);
  if (!rawDate) return due.toISOString().split("T")[0];
  const days = { lunes:1, martes:2, "miércoles":3, jueves:4, viernes:5, "sábado":6, domingo:0 };
  const key = Object.keys(days).find(k => rawDate.toLowerCase().includes(k));
  if (key) {
    const diff = (days[key] - new Date().getDay() + 7) % 7 || 7;
    due = new Date();
    due.setDate(due.getDate() + diff);
  }
  if (rawDate.toLowerCase().includes("hoy")) {
    due = new Date();
  }
  if (rawDate.toLowerCase().includes("mañana")) {
    due = new Date();
    due.setDate(due.getDate() + 1);
  }
  return due.toISOString().split("T")[0];
}

function parseHora(text) {
  const match = text.match(/a las (\d{1,2}(?::\d{2})?)\s*(am|pm)?/i);
  if (!match) return "";
  let hora = match[1];
  const ampm = match[2];
  if (!hora.includes(":")) hora = hora + ":00";
  if (ampm) {
    let [h, m] = hora.split(":").map(Number);
    if (ampm.toLowerCase() === "pm" && h < 12) h += 12;
    if (ampm.toLowerCase() === "am" && h === 12) h = 0;
    hora = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return hora;
}

function formatTask(t, i) {
  const hora = t.hora ? ` a las ${t.hora}` : "";
  const cliente = t.cliente ? ` #${t.cliente}` : "";
  return `${i+1}. ${t.title}${cliente}${hora} — ${t.priority.toUpperCase()} — vence ${t.due}`;
}

async function sendWhatsApp(to, body) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to:   `whatsapp:${to}`,
    body,
  });
}

// ─── Procesador de mensajes ───────────────────────────────────────────────────
async function parseMessage(msg, phone) {
  const lower = msg.toLowerCase().trim();

  // Ver lista
  if (lower.startsWith("lista")) {
    const clienteMatch = msg.match(/#(\S+)/);
    const query = { phone, status: { $ne: "completada" } };
    if (clienteMatch) query.cliente = new RegExp(clienteMatch[1], "i");
    const tasks = await Task.find(query).sort({ due: 1, hora: 1 });
    if (tasks.length === 0) return clienteMatch
      ? `No hay tareas pendientes para #${clienteMatch[1]}.`
      : "No tienes tareas pendientes. ¡Buen trabajo! 🎉";
    return (
      `📋 *Tareas pendientes (${tasks.length}):*\n` +
      tasks.map((t, i) => formatTask(t, i)).join("\n") +
      "\n\nEscribe *listo #N* para completar una."
    );
  }

  // Marcar como completada
  const doneMatch = lower.match(/^(listo|done|completada?)\s*#?(\d+)/);
  if (doneMatch) {
    const idx = parseInt(doneMatch[2]) - 1;
    const tasks = await Task.find({ phone, status: { $ne: "completada" } }).sort({ due: 1 });
    if (tasks[idx]) {
      await Task.findByIdAndUpdate(tasks[idx]._id, { status: "completada" });
      return `✅ Completada: "${tasks[idx].title}"`;
    }
    return `No encontré la tarea #${doneMatch[2]}. Escribe *lista* para ver tus tareas.`;
  }

  // Nueva tarea
  const newMatch = msg.match(/^nueva tarea[:\s]+(.+)/i);
  if (newMatch) {
    let raw = newMatch[1].trim();

    // Extraer cliente (#nombre)
    const clienteMatch = raw.match(/#(\S+)/);
    const cliente = clienteMatch ? clienteMatch[1] : "";
    raw = raw.replace(/#\S+/, "").trim();

    // Extraer prioridad
    const prioMatch = raw.match(/prioridad\s+(alta|media|baja)/i);
    const priority = prioMatch ? prioMatch[1].toLowerCase() : "media";
    raw = raw.replace(/prioridad\s+(alta|media|baja)/i, "").trim();

    // Extraer hora
    const hora = parseHora(raw);
    raw = raw.replace(/a las \d{1,2}(?::\d{2})?\s*(?:am|pm)?/i, "").trim();

    // Extraer fecha
    const fechaMatch = raw.match(/para el?\s+(\S+)/i);
    const due = parseDueDate(fechaMatch ? fechaMatch[1] : "");
    raw = raw.replace(/para el?\s+\S+/i, "").trim();

    // Título
    const title = raw.replace(/,\s*$/, "").trim();
    if (!title) return "No entendí el nombre de la tarea. Ejemplo:\n*nueva tarea: revisar contrato #García para el viernes a las 10:00 prioridad alta*";

    await Task.create({ phone, title, due, hora, priority, cliente, status: "pendiente" });
    const horaStr = hora ? ` a las ${hora}` : "";
    const clienteStr = cliente ? ` #${cliente}` : "";
    return (
      `✅ Tarea agregada:\n*${title}*${clienteStr}${horaStr}\n` +
      `Prioridad: ${priority} | Vence: ${due}\n\nEscribe *lista* para ver todas tus tareas.`
    );
  }

  // Clientes
  if (lower === "clientes") {
    const tasks = await Task.find({ phone, status: { $ne: "completada" }, cliente: { $ne: "" } });
    const clientes = [...new Set(tasks.map(t => t.cliente))];
    if (clientes.length === 0) return "No tienes tareas con etiqueta de cliente aún.";
    return `👥 *Clientes con tareas activas:*\n` + clientes.map(c => `• #${c}`).join("\n");
  }

  // Ayuda
  if (lower === "ayuda" || lower === "help") {
    return (
      `🤖 *Comandos disponibles:*\n\n` +
      `• *lista* — ver tareas pendientes\n` +
      `• *lista #García* — tareas de un cliente\n` +
      `• *nueva tarea: [nombre]* — agregar tarea\n` +
      `• *nueva tarea: contrato #García para el viernes a las 11:00 prioridad alta*\n` +
      `• *listo #2* — marcar tarea como completada\n` +
      `• *clientes* — ver clientes con tareas activas\n` +
      `• *ayuda* — ver estos comandos`
    );
  }

  return `No entendí ese mensaje 🤔\nEscribe *ayuda* para ver los comandos disponibles.`;
}

// ─── Webhook WhatsApp ─────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const msg   = req.body.Body || "";
  const phone = (req.body.From || "").replace("whatsapp:", "");
  const twiml = new MessagingResponse();
  try {
    const reply = await parseMessage(msg, phone);
    twiml.message(reply);
  } catch (e) {
    console.error(e);
    twiml.message("Ocurrió un error. Intenta de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});

// ─── Keep-alive: ping cada 10 minutos ────────────────────────────────────────
cron.schedule("*/10 * * * *", () => {
  const url = process.env.RAILWAY_URL || "https://tareas-bot-production.up.railway.app";
  https.get(url, (res) => {
    console.log(`Keep-alive ping: ${res.statusCode}`);
  }).on("error", (e) => {
    console.error("Keep-alive error:", e.message);
  });
});

// ─── Recordatorio automático cada mañana a las 8am CDMX ──────────────────────
cron.schedule("0 13 * * *", async () => {
  console.log("Enviando recordatorios matutinos...");
  const today = new Date().toISOString().split("T")[0];
  const phones = await Task.distinct("phone", { status: { $ne: "completada" } });
  for (const phone of phones) {
    const tasks = await Task.find({
      phone,
      status: { $ne: "completada" },
      due: { $lte: today },
    }).sort({ due: 1, hora: 1 });
    if (tasks.length === 0) continue;
    const msg =
      `☀️ *Buenos días! Tus tareas para hoy:*\n\n` +
      tasks.map((t, i) => formatTask(t, i)).join("\n") +
      `\n\nEscribe *lista* para ver todas tus tareas.`;
    try { await sendWhatsApp(phone, msg); } catch (e) { console.error("Error enviando a", phone, e.message); }
  }
}, { timezone: "America/Mexico_City" });

// ─── Ruta de salud ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot de tareas activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor corriendo en puerto ${PORT}`));