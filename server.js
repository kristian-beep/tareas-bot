// server.js — Bot de tareas completo v3.5
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
  phone:       { type: String, required: true },
  title:       { type: String, required: true },
  due:         { type: String },
  hora:        { type: String, default: "" },
  priority:    { type: String, default: "media" },
  status:      { type: String, default: "pendiente" },
  cliente:     { type: String, default: "" },
  asignado_a:  { type: String, default: "" },  // número de teléfono del asignado
  asignado_nombre: { type: String, default: "" }, // nombre del asignado (@Gabriela)
  created:     { type: Date, default: Date.now },
});
const Task = mongoose.model("Task", taskSchema);

// ─── Directorio de usuarios del despacho ─────────────────────────────────────
// Agrega aquí los números de WhatsApp de cada miembro del despacho
const EQUIPO = {
  "@gabriela":  "+523316056355",
  "@kristian":  "+523335554865",
  "@jose":      "+523313547943",
  "@estefani":  "+523319042984",
  "@javier":    "+525581000410",
};

// ─── Meses ────────────────────────────────────────────────────────────────────
const MESES = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12
};
const MESES_NOMBRE = [
  "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fechaHoyMexico() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function formatearFecha(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} de ${MESES_NOMBRE[m]} de ${y}`;
}

function parseDueDate(raw) {
  if (!raw || raw.trim() === "") {
    const d = new Date(fechaHoyMexico());
    d.setDate(d.getDate() + 3);
    return d.toISOString().split("T")[0];
  }
  const lower = raw.toLowerCase().trim();
  if (lower === "hoy" || lower === "today") return fechaHoyMexico();
  if (lower === "mañana" || lower === "tomorrow") {
    const d = new Date(fechaHoyMexico());
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  }
  const completa = lower.match(/^(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?$/);
  if (completa) {
    const dia = parseInt(completa[1]);
    const mes = MESES[completa[2]];
    const anio = completa[3] ? parseInt(completa[3]) : new Date().getFullYear();
    if (mes) return new Date(anio, mes - 1, dia).toISOString().split("T")[0];
  }
  const diasSemana = { lunes:1, martes:2, "miércoles":3, jueves:4, viernes:5, "sábado":6, domingo:0 };
  const key = Object.keys(diasSemana).find(k => lower.includes(k));
  if (key) {
    const hoyDate = new Date(fechaHoyMexico());
    const diff = (diasSemana[key] - hoyDate.getDay() + 7) % 7 || 7;
    hoyDate.setDate(hoyDate.getDate() + diff);
    return hoyDate.toISOString().split("T")[0];
  }
  const d = new Date(fechaHoyMexico());
  d.setDate(d.getDate() + 3);
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
  const asignado = t.asignado_nombre ? ` → ${t.asignado_nombre}` : "";
  return `${i+1}. ${t.title}${cliente}${hora}${asignado} — ${t.priority.toUpperCase()} — vence ${fecha}`;
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
      "\n\nEscribe *listo #N*, *eliminar #N* o *editar #N campo valor*."
    );
  }

  // Ver completadas
  if (lower.startsWith("completadas")) {
    const clienteMatch = msg.match(/#(\S+)/);
    const query = { phone, status: "completada" };
    if (clienteMatch) query.cliente = new RegExp(clienteMatch[1], "i");
    const tasks = await Task.find(query).sort({ created: -1 }).limit(20);
    if (tasks.length === 0) return clienteMatch
      ? `No hay tareas completadas para #${clienteMatch[1]}.`
      : "No tienes tareas completadas aún.";
    return (
      `✅ *Tareas completadas (últimas ${tasks.length}):*\n` +
      tasks.map((t, i) => {
        const cliente = t.cliente ? ` #${t.cliente}` : "";
        const fecha = formatearFecha(t.due);
        return `${i+1}. ${t.title}${cliente} — vencía ${fecha}`;
      }).join("\n")
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

  // Eliminar tarea
  const eliminarMatch = lower.match(/^(eliminar|borrar|delete)\s*#?(\d+)/);
  if (eliminarMatch) {
    const idx = parseInt(eliminarMatch[2]) - 1;
    const tasks = await Task.find({ phone, status: { $ne: "completada" } }).sort({ due: 1 });
    if (tasks[idx]) {
      const titulo = tasks[idx].title;
      await Task.findByIdAndDelete(tasks[idx]._id);
      return `🗑️ Eliminada: "${titulo}"`;
    }
    return `No encontré la tarea #${eliminarMatch[2]}. Escribe *lista* para ver tus tareas.`;
  }

  // Editar tarea
  const editarMatch = lower.match(/^editar\s*#?(\d+)\s+(\w+)\s+(.+)/);
  if (editarMatch) {
    const idx = parseInt(editarMatch[1]) - 1;
    const campo = editarMatch[2].toLowerCase();
    const valor = msg.match(/^editar\s*#?\d+\s+\w+\s+(.+)/i)?.[1]?.trim();
    const tasks = await Task.find({ phone, status: { $ne: "completada" } }).sort({ due: 1 });
    if (!tasks[idx]) return `No encontré la tarea #${editarMatch[1]}. Escribe *lista* para ver tus tareas.`;
    const task = tasks[idx];
    let update = {};
    let confirmacion = "";
    if (campo === "fecha") {
      const nuevaFecha = parseDueDate(valor);
      update = { due: nuevaFecha };
      confirmacion = `📅 Fecha actualizada a: ${formatearFecha(nuevaFecha)}`;
    } else if (campo === "hora") {
      const nuevaHora = parseHora(`a las ${valor}`);
      update = { hora: nuevaHora };
      confirmacion = `🕐 Hora actualizada a: ${nuevaHora}`;
    } else if (campo === "prioridad") {
      const prio = valor.toLowerCase();
      if (!["alta", "media", "baja"].includes(prio)) return "Prioridad debe ser: alta, media o baja.";
      update = { priority: prio };
      confirmacion = `⚡ Prioridad actualizada a: ${prio.toUpperCase()}`;
    } else if (campo === "cliente") {
      update = { cliente: valor.replace("#", "") };
      confirmacion = `👤 Cliente actualizado a: #${valor.replace("#", "")}`;
    } else if (campo === "nombre") {
      update = { title: valor };
      confirmacion = `✏️ Nombre actualizado a: "${valor}"`;
    } else {
      return `Campo no reconocido. Puedes editar:\n• *fecha*\n• *hora*\n• *prioridad*\n• *cliente*\n• *nombre*`;
    }
    await Task.findByIdAndUpdate(task._id, update);
    return `${confirmacion}\n\nTarea: "${task.title}"\nEscribe *lista* para ver tus tareas.`;
  }

  // Nueva tarea
  if (lower.startsWith("nueva tarea")) {
    let raw = msg.replace(/^nueva tarea[:\s]*/i, "").trim();

    // Extraer asignado (@nombre)
    const asignadoMatch = raw.match(/asignar\s+(@\S+)/i);
    const asignadoNombre = asignadoMatch ? asignadoMatch[1].toLowerCase() : "";
    const asignadoPhone = asignadoNombre ? (EQUIPO[asignadoNombre] || "") : "";
    raw = raw.replace(/asignar\s+@\S+/i, "").trim();

    const clienteMatch = raw.match(/#(\S+)/);
    const cliente = clienteMatch ? clienteMatch[1] : "";
    raw = raw.replace(/#\S+/, "").trim();

    const prioMatch = raw.match(/prioridad\s+(alta|media|baja)/i);
    const priority = prioMatch ? prioMatch[1].toLowerCase() : "media";
    raw = raw.replace(/prioridad\s+(alta|media|baja)/i, "").trim();

    const hora = parseHora(raw);
    raw = raw.replace(/a las \d{1,2}(?::\d{2})?\s*(?:am|pm)?/i, "").trim();

    let fechaRaw = "";
    const fechaCompleta = raw.match(/\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?/i);
    if (fechaCompleta) {
      fechaRaw = fechaCompleta[0];
      raw = raw.replace(fechaCompleta[0], "").trim();
    } else if (/para el?\s+\S+/i.test(raw)) {
      const paraEl = raw.match(/para el?\s+(\S+)/i);
      fechaRaw = paraEl[1];
      raw = raw.replace(/para el?\s+\S+/i, "").trim();
    } else if (/\bhoy\b/i.test(raw)) {
      fechaRaw = "hoy";
      raw = raw.replace(/\bhoy\b/i, "").trim();
    } else if (/\bmañana\b/i.test(raw)) {
      fechaRaw = "mañana";
      raw = raw.replace(/\bmañana\b/i, "").trim();
    }

    const due = parseDueDate(fechaRaw);
    const title = raw.replace(/,\s*$/, "").trim();

    if (!title) return "No entendí el nombre de la tarea. Ejemplo:\n*nueva tarea: Audiencia #Costco 22 de abril de 2026 a las 10:00 prioridad alta*";

    await Task.create({ phone, title, due, hora, priority, cliente,
      asignado_a: asignadoPhone, asignado_nombre: asignadoNombre, status: "pendiente" });

    const horaStr = hora ? ` a las ${hora}` : "";
    const clienteStr = cliente ? ` #${cliente}` : "";
    let respuesta = (
      `✅ *Tarea agregada:*\n${title}${clienteStr}${horaStr}\n` +
      `Prioridad: ${priority} | Vence: ${formatearFecha(due)}`
    );

    // Notificar al asignado
    if (asignadoPhone) {
      try {
        await sendWhatsApp(asignadoPhone,
          `📌 *Se te asignó una tarea:*\n${title}${clienteStr}${horaStr}\n` +
          `Prioridad: ${priority} | Vence: ${formatearFecha(due)}\n\nEscribe *lista* para ver tus tareas.`
        );
        respuesta += `\n\nNotificación enviada a ${asignadoNombre} ✓`;
      } catch (e) {
        respuesta += `\n\n⚠️ No se pudo notificar a ${asignadoNombre}.`;
      }
    }

    respuesta += `\n\nEscribe *lista* para ver todas tus tareas.`;
    return respuesta;
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
      `• *completadas* — ver historial de tareas completadas\n` +
      `• *completadas #García* — completadas de un cliente\n` +
      `• *nueva tarea: [nombre]* — agregar tarea\n` +
      `• *nueva tarea: contrato #García para el viernes a las 10:00 prioridad alta*\n` +
      `• *nueva tarea: contrato #García para el viernes asignar @Gabriela prioridad alta*\n` +
      `• *listo #2* — marcar tarea como completada\n` +
      `• *eliminar #2* — borrar una tarea\n` +
      `• *editar #2 fecha 25 de abril de 2026*\n` +
      `• *editar #2 hora 11:00*\n` +
      `• *editar #2 prioridad alta*\n` +
      `• *editar #2 cliente García*\n` +
      `• *editar #2 nombre Nuevo nombre*\n` +
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

// ─── Recordatorio diario 8am CDMX ────────────────────────────────────────────
cron.schedule("0 13 * * *", async () => {
  console.log("Enviando recordatorios matutinos...");
  const today = fechaHoyMexico();
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

// ─── Resumen semanal — lunes 8am CDMX ────────────────────────────────────────
cron.schedule("0 13 * * 1", async () => {
  console.log("Enviando resumen semanal...");
  const hoy = new Date(fechaHoyMexico());
  const finSemana = new Date(hoy);
  finSemana.setDate(hoy.getDate() + 6);
  const finStr = finSemana.toISOString().split("T")[0];

  const phones = await Task.distinct("phone", { status: { $ne: "completada" } });
  for (const phone of phones) {
    const tasks = await Task.find({
      phone, status: { $ne: "completada" },
      due: { $gte: fechaHoyMexico(), $lte: finStr },
    }).sort({ due: 1, hora: 1 });
    if (tasks.length === 0) continue;
    const msg =
      `📅 *Resumen semanal — semana del ${formatearFecha(fechaHoyMexico())}:*\n\n` +
      tasks.map((t, i) => formatTask(t, i)).join("\n") +
      `\n\n¡Buena semana! Escribe *lista* para ver todas tus tareas.`;
    try { await sendWhatsApp(phone, msg); } catch (e) { console.error("Error:", e.message); }
  }
}, { timezone: "America/Mexico_City" });

// ─── Servidor ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Bot de tareas activo ✓"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor corriendo en puerto ${PORT}`));