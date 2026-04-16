// server.js — Bot de tareas con MongoDB, múltiples usuarios y recordatorios
// npm install express twilio dotenv mongoose node-cron

import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cron from "node-cron";
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
  phone:    { type: String, required: true },  // número de WhatsApp del usuario
  title:    { type: String, required: true },
  due:      { type: String },
  priority: { type: String, default: "media" },
  status:   { type: String, default: "pendiente" },
  cliente:  { type: String, default: "" },     // etiqueta #cliente
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
  return due.toISOString().split("T")[0];
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

  // Ver lista (opcionalmente filtrar por cliente)
  if (lower.startsWith("lista")) {
    const clienteMatch = msg.match(/#(\S+)/);
    const query = { phone, status: { $ne: "completada" } };
    if (clienteMatch) query.cliente = new RegExp(clienteMatch[1], "i");
    const tasks = await Task.find(query).sort({ due: 1 });
    if (tasks.length === 0) return clienteMatch
      ? `No hay tareas pendientes para #${clienteMatch[1]}.`
      : "No tienes tareas pendientes. ¡Buen trabajo! 🎉";
    return (
      `📋 *Tareas pendientes (${tasks.length}):*\n` +
      tasks.map((t, i) =>
        `${i+1}. ${t.title}${t.cliente ? " #"+t.cliente : ""} — ${t.priority.toUpperCase()} — vence ${t.due}`
      ).join("\n") +
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
  const newMatch = msg.match(
    /(?:nueva tarea|agregar|nueva|add)[:\s]+(.+?)(?:\s+para\s+el\s+(\S+))?(?:\s+prioridad\s+(alta|media|baja))?$/i
  );
  if (newMatch) {
    let title = newMatch[1].replace(/\s+para\s+el.*/i, "").trim();
    const clienteMatch = title.match(/#(\S+)/);
    const cliente = clienteMatch ? clienteMatch[1] : "";
    title = title.replace(/#\S+/, "").trim();
    const due = parseDueDate(newMatch[2]);
    const priority = (newMatch[3] || "media").toLowerCase();
    await Task.create({ phone, title, due, priority, cliente, status: "pendiente" });
    return (
      `✅ Tarea agregada:\n*${title}*${cliente ? " #"+cliente : ""}\n` +
      `Prioridad: ${priority} | Vence: ${due}\n\nEscribe *lista* para ver todas tus tareas.`
    );
  }

  // Clientes registrados
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
      `• *nueva tarea: contrato #García para el viernes prioridad alta*\n` +
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

// ─── Recordatorio automático cada mañana a las 8am hora CDMX ─────────────────
cron.schedule("0 13 * * *", async () => {  // 13:00 UTC = 8:00 CDMX (horario de verano)  console.log("Enviando recordatorios matutinos...");
  const today = new Date().toISOString().split("T")[0];
  const phones = await Task.distinct("phone", { status: { $ne: "completada" } });
  for (const phone of phones) {
    const tasks = await Task.find({
      phone,
      status: { $ne: "completada" },
      due: { $lte: today },
    }).sort({ due: 1 });
    if (tasks.length === 0) continue;
    const msg =
      `☀️ *Buenos días! Tus tareas para hoy:*\n\n` +
      tasks.map((t, i) =>
        `${i+1}. ${t.title}${t.cliente ? " #"+t.cliente : ""} — ${t.priority.toUpperCase()}`
      ).join("\n") +
      `\n\nEscribe *lista* para ver todas tus tareas.`;
    try { await sendWhatsApp(phone, msg); } catch (e) { console.error("Error enviando a", phone, e.message); }
  }
}, { timezone: "America/Mexico_City" });

// ─── Ruta de salud ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot de tareas activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor corriendo en puerto ${PORT}`));