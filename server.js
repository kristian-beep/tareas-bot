// server.js — Bot de tareas para WhatsApp via Twilio
// npm install express twilio dotenv

import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const { MessagingResponse } = twilio.twiml;

// Base de datos en memoria (sustituir con DB real en producción)
let tasks = [];
let nextId = 1;

function parseMessage(msg) {
  const lower = msg.toLowerCase().trim();

  // Ver lista
  if (lower === "lista" || lower === "mis tareas") {
    const pending = tasks.filter(t => t.status !== "completada");
    if (pending.length === 0) return "No tienes tareas pendientes. ¡Buen trabajo! 🎉";
    return (
      `📋 *Tus tareas pendientes (${pending.length}):*\n` +
      pending.map((t, i) => `${i + 1}. ${t.title} — ${t.priority.toUpperCase()} — vence ${t.due}`).join("\n") +
      "\n\nEscribe *listo #N* para completar una tarea."
    );
  }

  // Marcar como completada
  const doneMatch = lower.match(/^(listo|done|completada?)\s*#?(\d+)/);
  if (doneMatch) {
    const idx = parseInt(doneMatch[2]) - 1;
    const pending = tasks.filter(t => t.status !== "completada");
    if (pending[idx]) {
      const task = pending[idx];
      tasks = tasks.map(t => t.id === task.id ? { ...t, status: "completada" } : t);
      return `✅ Completada: "${task.title}"`;
    }
    return `No encontré la tarea #${doneMatch[2]}. Escribe *lista* para ver tus tareas.`;
  }

  // Nueva tarea (lenguaje natural)
  const newMatch = msg.match(
    /(?:nueva tarea|agregar|nueva|add)[:\s]+(.+?)(?:\s+para\s+el\s+(.+?))?(?:\s+prioridad\s+(alta|media|baja))?$/i
  );
  if (newMatch) {
    const title = newMatch[1].replace(/\s+para\s+el.*/i, "").trim();
    const rawDate = newMatch[2];
    let due = new Date();
    due.setDate(due.getDate() + 3);

    if (rawDate) {
      const days = { lunes: 1, martes: 2, miércoles: 3, jueves: 4, viernes: 5, sábado: 6, domingo: 0 };
      const dayKey = Object.keys(days).find(k => rawDate.toLowerCase().includes(k));
      if (dayKey) {
        const diff = (days[dayKey] - due.getDay() + 7) % 7 || 7;
        due = new Date();
        due.setDate(due.getDate() + diff);
      }
    }

    const priority = (newMatch[3] || "media").toLowerCase();
    const task = {
      id: nextId++,
      title,
      due: due.toISOString().split("T")[0],
      priority,
      status: "pendiente",
      created: new Date().toISOString(),
    };
    tasks.push(task);
    return `✅ Tarea agregada:\n*${title}*\nPrioridad: ${priority} | Vence: ${task.due}\n\nEscribe *lista* para ver todas tus tareas.`;
  }

  // Ayuda
  if (lower === "ayuda" || lower === "help") {
    return (
      `🤖 *Comandos disponibles:*\n\n` +
      `• *lista* — ver tareas pendientes\n` +
      `• *nueva tarea: [nombre]* — agregar tarea\n` +
      `• *nueva tarea: [nombre] para el viernes* — con fecha\n` +
      `• *nueva tarea: [nombre] prioridad alta* — con prioridad\n` +
      `• *listo #2* — marcar tarea como completada\n` +
      `• *ayuda* — ver estos comandos`
    );
  }

  return `No entendí ese mensaje 🤔\nEscribe *ayuda* para ver los comandos disponibles.`;
}

// Webhook que Twilio llama cuando llega un mensaje de WhatsApp
app.post("/webhook/whatsapp", (req, res) => {
  const incomingMsg = req.body.Body || "";
  const twiml = new MessagingResponse();
  const reply = parseMessage(incomingMsg);
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

// Ruta de salud
app.get("/", (req, res) => res.send("Bot de tareas activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor corriendo en puerto ${PORT}`));