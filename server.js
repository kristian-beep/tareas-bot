// server.js — Bot de tareas completo v3
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

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.error("Error MongoDB:", err));

const taskSchema = new mongoose.Schema({
  phone:    { type: String, required: true },
  title:    { type: String, required: true },
  due:      { type: String },           // formato ISO: 2026-04-22
  hora:     { type: String, default: "" },
  priority: { type: String, default: "media" },
  status:   { type: String, default: "pendiente" },
  cliente:  { type: String, default: "" },
  created:  { type: Date, default: Date.now },
});
const Task = mongoose.model("Task", taskSchema);

// ─── Helpers de fecha ─────────────────────────────────────────────────────────
const MESES = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12
};

const MESES_NOMBRE = [
  "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

function formatearFecha(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} de ${MESES_NOMBRE[m]} de ${y}`;
}

function parseDueDate(raw) {
  if (!raw) {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return d.toISOString().split("T")[0];
  }
  const lower = raw.toLowerCase().trim();

  // Fecha completa: "22 de abril de 2026" o "22 de abril"
  const completa = lower.match(/(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?/);
  if (completa) {
    const dia = parseInt(completa[1]);
    const mes = MESES[completa[2]];
    const anio = completa[3] ? parseInt(completa[3]) : new Date().getFullYear();
    if (mes) {
      const fecha = new Date(anio, mes - 1, dia);
      return fecha.toISOString().split("T")[0];
    }
  }

  // Día de la semana: "miércoles", "viernes"
  const dias = { lunes:1, martes:2, "miércoles":3, jueves:4, viernes:5, "sábado":6, domingo:0 };
  const key = Object.keys(dias).find(k => lower.includes(k));
  if (key) {
    const hoy = new Date();
    const diff = (dias[key] - hoy.getDay() + 7) % 7 || 7;
    const d = new Date(); d.setDate(d.getDate() + diff);
    return d.toISOString().split("T")[0];
  }

  if (lower.includes("hoy")) return new Date().toISOString().split("T")[0];
  if (lower.includes("mañana")) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  }

  const d = new Date(); d.setDate(d.getDate() + 3);
  return d.toISOString().split("T")[0];
}

function parseHora(text) {
  const match = text.match(/a las (\d{1,2}(?::\d{2})?)\s*(am|pm)?/i);
  if (!match) return "";
  let hora = match[1];
  const ampm = match[2];
  if (!hora.includes(":")) hora += ":00";
  if (ampm) {
    let [h, m] = hora.split(":").map(Number);
    if (ampm.toLowerCase() === "pm" && h < 12) h += 12;
    if (ampm.toLowerCase() === "am" && h === 12) h = 0;
    hora = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  return hora;
}

function formatTask(t, i) {
  const hora = t.hora ? ` a las ${t.hora}` : "";
  const cliente = t.cliente ? ` #${t.cliente}` : "";
  const fecha = formatearFecha(t.due);
  return `${i+1}. ${t.title}${cliente}${hora} — ${t.priority.toUpperCase()} — vence ${fecha}`;
}

async function sendWhatsApp(to, body) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to:   `whatsapp:${to}`,
    body,
  });
}

// ─── Parser de mensajes ───────────────────────────────────────────────────────
async function parseMessage(msg, phone) {
  const lower = msg.toLowerCase().trim();

  // Lista
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

  // Completar tarea
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
  if (lower.startsWith("nueva tarea")) {
    let raw = msg.replace(/^nueva tarea[:\s]*/i, "").trim();

    // Extraer cliente (#nombre) — solo la primera palabra después del #
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

    // Extraer fecha completa "22 de abril de 2026"
    let fechaRaw = "";
    const fechaCompleta = raw.match(/\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?/i);
    if (fechaCompleta) {
      fechaRaw = fechaCompleta[0];
      raw = raw.replace(fechaCompleta[0], "").trim();
    } else {
      // Extraer "para el [día]"
      const paraEl = raw.match(/para el?\s+(\S+)/i);
      if (paraEl) {
        fechaRaw = paraEl[1];
        raw = raw.replace(/para el?\s+\S+/i, "").trim();
      }
    }

    const due = parseDueDate(fechaRaw);
    const title = raw.replace(/,\s*$/, "").trim();

    if (!title) return "No entendí el nombre de la tarea. Ejemplo:\n*nueva tarea: Audiencia Juzgado 21 CA 123/2025 #Costco 22 de abril de 2026 a las 10:00 prioridad alta*";

    await Task.create({ phone, title, due, hora, priority, cliente, status: "pendiente" });

    const horaStr = hora ? ` a las ${hora}` : "";
    const clienteStr = cliente ? ` #${cliente}` : "";
    const fechaStr = formatearFecha(due);

    return (
      `✅ *Tarea agregada:*\n${title}${clienteStr}${horaStr}\n` +
      `Prioridad: ${priority} | Vence: ${fechaStr}\n\n` +
      `Escribe *lista* para ver todas tus tareas.`
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
      `• *nueva tarea: Audiencia Juzgado 21 CA 123/2025 #Costco 22 de abril de 2026 a las 10:00 prioridad alta*\n` +
      `• *listo #2* — marcar tarea como completada\n` +
      `• *clientes* — ver clientes con tareas activas\n` +
      `• *ayuda* — ver estos comandos`
    );
  }

  return `No entendí ese mensaje 🤔\nEscribe *ayuda* para ver los comandos disponibles.`;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
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

// ─── Keep-alive ───────────────────────────────────────────────────────────────
cron.schedule("*/10 * * * *", () => {
  const url = process.env.RAILWAY_URL || "https://tareas-bot-production.up.railway.app";
  https.get(url, (res) => {
    console.log(`Keep-alive ping: ${res.statusCode}`);
  }).on("error", (e) => console.error("Keep-alive error:", e.message));
});

// ─── Recordatorio 8am CDMX ───────────────────────────────────────────────────
cron.schedule("0 13 * * *", async () => {
  console.log("Enviando recordatorios matutinos...");
  const today = new Date().toISOString().split("T")[0];
  const phones = await Task.distinct("phone", { status: { $ne: "completada" } });
  for (const phone of phones) {
    const tasks = await Task.find({
      phone, status: { $ne: "completada" }, due: { $lte: today },
    }).sort({ due: 1, hora: 1 });
    if (tasks.length === 0) continue;
    const msg =
      `☀️ *Buenos días! Tus tareas para hoy:*\n\n` +
      tasks.map((t, i) => formatTask(t, i)).join("\n") +
      `\n\nEscribe *lista* para ver todas tus tareas.`;
    try { await sendWhatsApp(phone, msg); } catch (e) { console.error("Error:", e.message); }
  }
}, { timezone: "America/Mexico_City" });

// ─── Servidor ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot de tareas activo ✓"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor corriendo en puerto ${PORT}`));