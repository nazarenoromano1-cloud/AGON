import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const STORAGE_KEY = "definicion-v6";
const SETTINGS_KEY = "definicion-settings-v6";
const ROUTINES_KEY = "definicion-routines-v6";
const EXERCISES_KEY = "definicion-exercises-v6";

const defaultDay = () => ({ steps: "", gym: false, gymType: "", gymRoutineId: null, exercises: [], meals: [], weight: "", notes: "", waterGlasses: 0, photos: [], measurements: {} });
const defaultSettings = () => ({ bodyWeight: "", tdee: "", proteinGoal: "", carbsGoal: "", fatGoal: "", goalWeight: "", goalWeeks: "", stepsGoal: "10000", waterGoal: "8", weekPlan: { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "", 0: "" } });

const GYM_TYPES = ["Upper", "Lower", "Push", "Pull", "Legs", "Full body", "Cardio", "Abdomen"];
const MEAL_TIMES = ["Desayuno", "Almuerzo", "Merienda", "Cena", "Snack", "Pre-entreno", "Post-entreno"];
const DAY_NAMES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MEASURE_FIELDS = [{ key: "waist", label: "Cintura", icon: "📏" }, { key: "chest", label: "Pecho", icon: "💪" }, { key: "hip", label: "Cadera", icon: "📐" }, { key: "arm", label: "Brazo", icon: "💪" }, { key: "thigh", label: "Muslo", icon: "🦵" }];

function todayKey() { return new Date().toISOString().slice(0, 10); }
function todayDow() { return new Date().getDay(); }

function formatDate(key, short = false) {
  const [y, m, d] = key.split("-");
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const date = new Date(y, m - 1, d);
  return short ? `${d}/${m}` : `${DAY_NAMES[date.getDay()]} ${d} ${months[m - 1]}`;
}

function getDayScore(d) {
  if (!d) return 0;
  return [(parseRange(d.steps) || 0) >= 10000, d.gym, (d.meals || []).length >= 3].filter(Boolean).length;
}

function getDayTotals(d) {
  if (!d) return { cal: 0, prot: 0, carbs: 0, fat: 0 };
  const w = (d.meals || []).filter(m => m.nutrition);
  return w.reduce((a, m) => ({ cal: a.cal + (m.nutrition.calorias || 0), prot: a.prot + (m.nutrition.proteinas_g || 0), carbs: a.carbs + (m.nutrition.carbos_g || 0), fat: a.fat + (m.nutrition.grasas_g || 0) }), { cal: 0, prot: 0, carbs: 0, fat: 0 });
}

function getCategoryStreak(allData, checkFn) {
  const keys = Object.keys(allData).sort().reverse();
  const today = todayKey();
  let streak = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i === 0 && key !== today) {
      const prev = new Date(today); prev.setDate(prev.getDate() - 1);
      if (key !== prev.toISOString().slice(0, 10)) break;
    }
    if (checkFn(allData[key])) streak++;
    else break;
  }
  return streak;
}

// ── API ───────────────────────────────────────────────────────────

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";
// Parsea valores numéricos que pueden ser rangos: "8-12", "8 a 12", "8/12" → promedio
function parseRange(val) {
  if (val === null || val === undefined || val === "") return 0;
  const s = val.toString().trim();
  // Rango con guión: "8-12" o "140-150" (cuidado con negativos)
  const dashMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
  if (dashMatch) return (parseFloat(dashMatch[1]) + parseFloat(dashMatch[2])) / 2;
  // Rango con "a": "8 a 12"
  const aMatch = s.match(/^(\d+(?:\.\d+)?)\s+a\s+(\d+(?:\.\d+)?)$/i);
  if (aMatch) return (parseFloat(aMatch[1]) + parseFloat(aMatch[2])) / 2;
  // Rango con "/": "8/12"
  const slashMatch = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (slashMatch) return (parseFloat(slashMatch[1]) + parseFloat(slashMatch[2])) / 2;
  // Número simple
  return parseFloat(s) || 0;
}


async function callClaude(body) {
  const messages = body.messages || [];
  const lastMsg = messages[messages.length - 1];
  let promptText = "";
  let imagePart = null;
  if (typeof lastMsg.content === "string") {
    promptText = lastMsg.content;
  } else if (Array.isArray(lastMsg.content)) {
    for (const block of lastMsg.content) {
      if (block.type === "text") promptText = block.text;
      if (block.type === "image") imagePart = { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    }
  }
  const parts = [];
  if (imagePart) parts.push(imagePart);
  parts.push({ text: promptText });
  const res = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] })
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/```json|```/g, "").trim();
}

async function checkMealAmbiguity(description) {
  const prompt = `El usuario quiere registrar esta comida para contar calorias con precision: "${description}".\nNecesitas hacer 1 o 2 preguntas cortas para estimar mejor las calorias? (porcion, gramaje, metodo de coccion, ingredientes clave como aceite/salsa, etc.)\nSi la descripcion ya es suficientemente precisa, NO preguntes nada.\nResponde SOLO con JSON sin backticks: {"necesita_aclaracion": true o false, "preguntas": ["pregunta1"]}\nMaximo 2 preguntas. Si no necesitas, devuelve {"necesita_aclaracion": false, "preguntas": []}`;
  return JSON.parse(await callClaude({ messages: [{ role: "user", content: prompt }] }));
}

async function analyzeMeal(description, aclaraciones = "", photoBase64 = null) {
  const fullDesc = aclaraciones ? description + ". Aclaraciones del usuario: " + aclaraciones : description;
  const prompt = `Analiza nutricionalmente esta comida${photoBase64 ? " (usa la imagen para estimar porciones con precision)" : ""}: "${fullDesc}". Se preciso con las porciones indicadas. Responde SOLO con JSON valido sin backticks:\n{"calorias":numero,"proteinas_g":numero,"carbos_g":numero,"grasas_g":numero,"nota":"observacion max 70 chars"}`;
  const msgContent = photoBase64
    ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } }, { type: "text", text: prompt }]
    : prompt;
  return JSON.parse(await callClaude({ messages: [{ role: "user", content: msgContent }] }));
}

async function analyzeRoutine(routine, bodyWeight) {
  const exList = (routine.exercises || []).map(e => e.name).join(", ");
  const text = await callClaude({
    messages: [{ role: "user", content: `Sos un entrenador. Una persona de ${bodyWeight || 75}kg hizo esta rutina de gym: ${routine.name} (${routine.type}). Ejercicios: ${exList}. Duracion estimada: ${routine.duration || 60} minutos. Responde SOLO con JSON valido sin backticks:\n{"calorias_quemadas":numero,"descripcion":"1 oracion sobre la rutina","proteina_recomendada_g":numero,"carbos_recomendados_g":numero,"consejo_post":"consejo nutricional post-entreno en 1 oracion"}` }]
  });
  return JSON.parse(text);
}

async function calcPreciseCalories(exercises, duration, bodyWeight) {
  const exDetail = exercises.map(e => `${e.name}: ${[e.sets && `${e.sets} series`, e.reps && `${e.reps} reps`, e.weightRange && `${e.weightRange}kg`].filter(Boolean).join(", ") || "sin detalle"}`).join("; ");
  const text = await callClaude({
    messages: [{ role: "user", content: `Sos un fisiologo del ejercicio. Persona de ${bodyWeight || 75}kg entreno durante aprox ${duration || 60} min. Ejercicios realizados: ${exDetail}. Calcula las calorias quemadas en base al volumen real de trabajo. Responde SOLO con JSON valido sin backticks:\n{"calorias_quemadas":numero,"intensidad":"baja|media|alta|muy alta","met_estimado":numero,"detalle":"1 oracion explicando el calculo"}` }]
  });
  return JSON.parse(text);
}

async function suggestExercises(routineType, goal, existingExercises, bodyWeight) {
  const existing = existingExercises.map(e => e.name).join(", ") || "ninguno aun";
  const text = await callClaude({
    messages: [{ role: "user", content: `Sos entrenador personal experto. Alguien de ${bodyWeight || 75}kg quiere armar una rutina de ${routineType}. Objetivo: ${goal || "bajar grasa y definir"}. Ya tiene: ${existing}. Sugiere 4 ejercicios complementarios con series, reps y peso inicial recomendado. Responde SOLO con JSON valido sin backticks:\n{"ejercicios":[{"nombre":"nombre","series":numero,"reps":"rango ej 8-12","peso_inicial":"ej 20-30kg o peso corporal","musculo_principal":"musculo","razon":"por que este ejercicio en 1 linea"}]}` }]
  });
  return JSON.parse(text);
}

async function analyzeExerciseProgress(exName, points, routineType) {
  if (points.length < 2) return null;
  const history = points.slice(-6).map(p => `${p.date}: ${[p.sets && `${p.sets}s`, p.reps && `${p.reps}r`, p.kg && `${p.kg}kg`].filter(Boolean).join("x") || "sin datos"}`).join(", ");
  const text = await callClaude({
    messages: [{ role: "user", content: `Sos entrenador. Historial del ejercicio "${exName}" (rutina ${routineType || "gym"}): ${history}. Analiza la progresion. Responde SOLO con JSON valido sin backticks:\n{"tendencia":"mejorando|estancado|retrocediendo|insuficientes datos","resumen":"2 oraciones sobre la progresion","sugerencia":"1 recomendacion concreta para la proxima sesion","proxima_meta":"peso o volumen objetivo para la proxima vez"}` }]
  });
  return JSON.parse(text);
}

async function getMealRecommendations(meals, settings, burnedCal = 0) {
  const withNut = meals.filter(m => m.nutrition);
  const totals = withNut.reduce((a, m) => ({ cal: a.cal + (m.nutrition.calorias || 0), prot: a.prot + (m.nutrition.proteinas_g || 0), carbs: a.carbs + (m.nutrition.carbos_g || 0), fat: a.fat + (m.nutrition.grasas_g || 0) }), { cal: 0, prot: 0, carbs: 0, fat: 0 });
  const mealsList = meals.map(m => `${m.mealTime || "sin horario"}: ${m.name}`).join(", ");

  const effectiveTDEE = (parseRange(settings.tdee) || 0) + burnedCal;
  const protGoal = parseRange(settings.proteinGoal) || 0;
  const carbsGoal = parseRange(settings.carbsGoal) || 0;
  const fatGoal = parseRange(settings.fatGoal) || 0;

  const remainingCal = effectiveTDEE > 0 ? Math.max(effectiveTDEE - Math.round(totals.cal), 0) : null;
  const remainingProt = protGoal > 0 ? Math.max(protGoal - Math.round(totals.prot), 0) : null;
  const remainingCarbs = carbsGoal > 0 ? Math.max(carbsGoal - Math.round(totals.carbs), 0) : null;
  const remainingFat = fatGoal > 0 ? Math.max(fatGoal - Math.round(totals.fat), 0) : null;

  const remainingStr = [
    remainingCal !== null && `${remainingCal} kcal`,
    remainingProt !== null && `${remainingProt}g proteína`,
    remainingCarbs !== null && `${remainingCarbs}g carbos`,
    remainingFat !== null && `${remainingFat}g grasas`,
  ].filter(Boolean).join(", ");

  const text = await callClaude({
    messages: [{ role: "user", content: `Sos nutricionista. Alguien que quiere bajar grasa comio hoy: ${mealsList}. Le faltan para completar sus metas: ${remainingStr || "metas no configuradas"}. Sugeri 3 comidas practicas y faciles para cerrar exactamente esos macros pendientes. Responde SOLO con JSON valido sin backticks:\n{"estado":"1 linea sobre como va el dia","recomendaciones":[{"nombre":"nombre corto","descripcion":"1 linea","calorias_aprox":numero,"proteinas_aprox":numero,"carbos_aprox":numero,"grasas_aprox":numero,"razon":"por que esta comida cierra los macros pendientes"}]}` }]
  });
  return JSON.parse(text);
}

async function getWeeklySummary(allData, settings) {
  const keys = Object.keys(allData).sort().reverse().slice(0, 7);
  const summary = keys.map(k => { const d = allData[k]; const t = getDayTotals(d); return `${formatDate(k)}: ${d.steps || 0} pasos, gym=${d.gym ? d.gymType || "si" : "no"}, ${d.meals?.length || 0} comidas, ${Math.round(t.cal)} kcal, ${Math.round(t.prot)}g prot, agua=${d.waterGlasses || 0}`; }).join("\n");
  return await callClaude({ messages: [{ role: "user", content: `Sos coach de fitness. Analiza esta semana de alguien que quiere bajar grasa y definir abdomen. Peso: ${settings.bodyWeight || "?"}kg, TDEE: ${settings.tdee || "?"} kcal, meta proteina: ${settings.proteinGoal || "?"}g.\n\n${summary}\n\nAnalisis conciso (max 4 parrafos): que estuvo bien, que mejorar, recomendacion concreta. Tono directo.` }] });
}

// ── Projections ───────────────────────────────────────────────────

function computeProjections(allData, settings) {
  const keys = Object.keys(allData).sort().reverse().slice(0, 14);
  if (keys.length === 0) return null;
  const tdee = parseRange(settings.tdee) || 0;
  const currentWeight = parseRange(settings.bodyWeight) || 0;
  const goalWeight = parseRange(settings.goalWeight) || 0;
  const goalWeeks = parseRange(settings.goalWeeks) || 12;
  const daysWithCal = keys.filter(k => getDayTotals(allData[k]).cal > 0);
  const avgCal = daysWithCal.length > 0 ? daysWithCal.reduce((a, k) => a + getDayTotals(allData[k]).cal, 0) / daysWithCal.length : 0;
  const avgDeficit = tdee > 0 && avgCal > 0 ? tdee - avgCal : 0;
  const weeklyLoss = avgDeficit > 0 ? (avgDeficit * 7) / 7700 : 0;
  const weightProjection = Array.from({ length: Math.max(goalWeeks, 12) + 1 }, (_, w) => ({ week: `S${w}`, weight: currentWeight > 0 ? parseFloat(Math.max(currentWeight - weeklyLoss * w, currentWeight - 20).toFixed(1)) : null, goal: goalWeight || null }));
  const totalDays = keys.length;
  const compliantDays = keys.filter(k => getDayScore(allData[k]) >= 2).length;
  const complianceRate = totalDays > 0 ? compliantDays / totalDays : 0;
  const kgToGoal = currentWeight > 0 && goalWeight > 0 ? currentWeight - goalWeight : null;
  const weeksToGoal = kgToGoal && weeklyLoss > 0 ? Math.ceil(kgToGoal / weeklyLoss) : null;
  return { weeklyLoss, avgDeficit: Math.round(avgDeficit), avgCal: Math.round(avgCal), weightProjection, complianceRate, weeksToGoal, kgToGoal, goalWeeks };
}

// ── Primitives ────────────────────────────────────────────────────

const inp = { width: "100%", background: "#0a0a14", border: "1px solid #1e1e32", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

function Sec({ title, children, accent }) {
  return (
    <div style={{ background: "#111120", borderRadius: 16, padding: "16px 18px", marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: accent || "#555", letterSpacing: 0.5, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function Toggle({ label, active, onToggle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 14, color: "#e2e8f0" }}>{label}</span>
      <button onClick={onToggle} style={{ width: 44, height: 24, borderRadius: 99, border: "none", cursor: "pointer", background: active ? "#7c3aed" : "#1e1e2e", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 2, left: active ? 22 : 2, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
      </button>
    </div>
  );
}

function StepsBar({ steps, goal = 10000, bodyWeight = 70 }) {
  const stepsNum = parseRange(steps) || 0;
  const goalNum = parseRange(goal) || 10000;
  const pct = Math.min(stepsNum / goalNum, 1);
  const color = pct >= 1 ? "#4ade80" : pct >= 0.6 ? "#facc15" : "#f87171";
  // MET ~3.5 for walking, formula: MET * weight * time(h), ~1.3km per 1000 steps, ~15min per km
  const km = stepsNum * 0.0008;
  const hours = km / 5; // ~5km/h walking
  const calBurned = Math.round(3.5 * bodyWeight * hours);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 4 }}>
        <span>{stepsNum.toLocaleString()} / {goalNum.toLocaleString()} pasos</span>
        <span style={{ color }}>{Math.round(pct * 100)}%</span>
      </div>
      <div style={{ height: 5, background: "#1e1e2e", borderRadius: 99 }}>
        <div style={{ height: 5, width: `${pct * 100}%`, background: color, borderRadius: 99, transition: "width 0.5s" }} />
      </div>
      {stepsNum > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#555" }}>
          <span>~{km.toFixed(1)} km caminados</span>
          <span style={{ color: "#facc1599" }}>~{calBurned} kcal quemadas</span>
        </div>
      )}
    </div>
  );
}

function NBadge({ label, value, sub, color }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#555" }}>{sub}</div>}
      <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>{label}</div>
    </div>
  );
}

function Lbl({ children }) {
  return <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>{children}</div>;
}

// ── Routines Manager ──────────────────────────────────────────────

function ExerciseProgressChart({ exName, allData, routineType }) {
  const points = [];
  Object.entries(allData).sort((a, b) => a[0].localeCompare(b[0])).forEach(([date, day]) => {
    (day.exercises || []).forEach(ex => {
      if (ex.name?.toLowerCase() === exName.toLowerCase()) {
        const maxKg = ex.weightRange ? parseRange(ex.weightRange) : null;
        const sets = Math.round(parseRange(ex.sets)) || null;
        const reps = Math.round(parseRange(ex.reps)) || null;
        if (maxKg || sets || reps) points.push({ date: formatDate(date, true), kg: maxKg, sets, reps, vol: maxKg && reps && sets ? maxKg * reps * sets : null });
      }
    });
  });

  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [loadingAi, setLoadingAi] = useState(false);

  const fetchAnalysis = async () => {
    setLoadingAi(true);
    try { setAiAnalysis(await analyzeExerciseProgress(exName, points, routineType)); } catch {}
    setLoadingAi(false);
  };

  if (points.length < 2) return <div style={{ fontSize: 12, color: "#444", padding: "8px 0" }}>Realizá este ejercicio al menos 2 veces para ver el progreso.</div>;

  const tendColor = { mejorando: "#4ade80", estancado: "#facc15", retrocediendo: "#f87171", "insuficientes datos": "#888" };

  return (
    <div>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>Peso máximo (kg)</div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={points} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#555" }} />
          <YAxis tick={{ fontSize: 9, fill: "#555" }} domain={["auto", "auto"]} />
          <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8, fontSize: 11 }} formatter={(v) => [v ? `${v}kg` : "—"]} />
          <Line type="monotone" dataKey="kg" stroke="#facc15" strokeWidth={2} dot={{ r: 3, fill: "#facc15" }} connectNulls />
        </LineChart>
      </ResponsiveContainer>

      {points.some(p => p.vol) && (
        <>
          <div style={{ fontSize: 11, color: "#555", marginBottom: 6, marginTop: 10 }}>Volumen total (series × reps × kg)</div>
          <ResponsiveContainer width="100%" height={70}>
            <LineChart data={points} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#555" }} />
              <YAxis tick={{ fontSize: 9, fill: "#555" }} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8, fontSize: 11 }} />
              <Line type="monotone" dataKey="vol" stroke="#7c3aed" strokeWidth={2} dot={{ r: 3, fill: "#7c3aed" }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {points.slice(-3).reverse().map((p, i) => (
          <div key={i} style={{ background: "#1a1a2e", borderRadius: 8, padding: "6px 10px", fontSize: 11, flex: 1 }}>
            <div style={{ color: "#555", marginBottom: 2 }}>{p.date}</div>
            <div style={{ color: "#e2e8f0" }}>{[p.sets && `${p.sets}s`, p.reps && `${p.reps}r`, p.kg && `${p.kg}kg`].filter(Boolean).join(" × ") || "—"}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, borderTop: "1px solid #1e1e2e", paddingTop: 12 }}>
        {!aiAnalysis && !loadingAi && (
          <button onClick={fetchAnalysis} style={{ width: "100%", padding: "9px 0", borderRadius: 10, border: "1px solid #7c3aed44", background: "#7c3aed11", color: "#7c3aed", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            🤖 Analizar progresión con IA
          </button>
        )}
        {loadingAi && <div style={{ textAlign: "center", fontSize: 12, color: "#555", padding: "12px 0" }}>Analizando tu historial…</div>}
        {aiAnalysis && (
          <div style={{ background: "#1a1a2e", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: tendColor[aiAnalysis.tendencia] || "#888", background: `${tendColor[aiAnalysis.tendencia]}22`, padding: "2px 8px", borderRadius: 99 }}>
                {aiAnalysis.tendencia === "mejorando" ? "📈" : aiAnalysis.tendencia === "estancado" ? "➡️" : aiAnalysis.tendencia === "retrocediendo" ? "📉" : "🔍"} {aiAnalysis.tendencia}
              </span>
            </div>
            <div style={{ fontSize: 13, color: "#c4c4d4", lineHeight: 1.6, marginBottom: 8 }}>{aiAnalysis.resumen}</div>
            <div style={{ background: "#7c3aed11", border: "1px solid #7c3aed33", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 2 }}>💡 Sugerencia</div>
              <div style={{ fontSize: 12, color: "#e2e8f0" }}>{aiAnalysis.sugerencia}</div>
            </div>
            <div style={{ fontSize: 11, color: "#4ade80" }}>🎯 Próxima meta: {aiAnalysis.proxima_meta}</div>
            <button onClick={() => setAiAnalysis(null)} style={{ marginTop: 8, background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 11 }}>Ocultar</button>
          </div>
        )}
      </div>
    </div>
  );
}

function RoutinesManager({ routines, onSave, onClose, allData }) {
  const [list, setList] = useState(routines);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", type: "Upper", duration: "60", exercises: [] });
  const [customTypes, setCustomTypes] = useState([]);
  const [addingCustomType, setAddingCustomType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [exForm, setExForm] = useState({ name: "", sets: "4", perSerieReps: false, reps: "", serieReps: [], perSerieWeight: false, weight: "", serieWeights: [], notes: "" });
  const [addingEx, setAddingEx] = useState(false);
  const [progressEx, setProgressEx] = useState(null);
  const [progressRoutine, setProgressRoutine] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionGoal, setSuggestionGoal] = useState("");
  const [exerciseBank, setExerciseBank] = useState(() => { try { return JSON.parse(localStorage.getItem(EXERCISES_KEY) || "[]"); } catch { return []; } });
  const [exSearch, setExSearch] = useState("");
  const [showBankDropdown, setShowBankDropdown] = useState(false);

  const saveToBank = (ex) => {
    setExerciseBank(prev => {
      const name = ex.name.trim().toLowerCase();
      const exists = prev.findIndex(e => e.name.toLowerCase() === name);
      let updated;
      if (exists >= 0) {
        updated = prev.map((e, i) => i === exists ? { ...e, sets: ex.sets, reps: ex.reps, weight: ex.weight, notes: ex.notes } : e);
      } else {
        updated = [...prev, { name: ex.name.trim(), sets: ex.sets, reps: ex.reps, weight: ex.weight, notes: ex.notes }];
      }
      localStorage.setItem(EXERCISES_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  const bankMatches = exSearch.length >= 1
    ? exerciseBank.filter(e => e.name.toLowerCase().includes(exSearch.toLowerCase())).slice(0, 6)
    : exerciseBank.slice(0, 6);

  const allTypes = [...GYM_TYPES, ...customTypes];

  const startNew = () => { setForm({ name: "", type: "Upper", duration: "60", exercises: [] }); setSuggestions(null); setEditing("new"); };
  const startEdit = (r) => { setForm({ ...r }); setSuggestions(null); setEditing(r.id); };

  const saveRoutine = () => {
    if (!form.name.trim()) return;
    let newList;
    if (editing === "new") newList = [...list, { ...form, id: Date.now() }];
    else newList = list.map(r => r.id === editing ? { ...form, id: editing } : r);
    setList(newList);
    onSave(newList);
    setEditing(null);
  };

  const updateEx = (idx, field, val) => setForm(f => ({ ...f, exercises: f.exercises.map((e, i) => i === idx ? { ...e, [field]: val } : e) }));
  const moveEx = (idx, dir) => setForm(f => { const arr = [...f.exercises]; [arr[idx], arr[idx + dir]] = [arr[idx + dir], arr[idx]]; return { ...f, exercises: arr }; });

  const addEx = () => {
    if (!exForm.name.trim()) return;
    const setsNum = Math.round(parseRange(exForm.sets)) || 1;
    const serieReps = exForm.perSerieReps
      ? Array.from({ length: setsNum }, (_, i) => exForm.serieReps[i] || "")
      : Array(setsNum).fill(exForm.reps);
    const serieWeights = exForm.perSerieWeight
      ? Array.from({ length: setsNum }, (_, i) => exForm.serieWeights[i] || "")
      : Array(setsNum).fill(exForm.weight);
    const newEx = { id: Date.now(), name: exForm.name, sets: exForm.sets, reps: exForm.reps, serieReps, perSerieReps: exForm.perSerieReps, weight: exForm.weight, serieWeights, perSerieWeight: exForm.perSerieWeight, notes: exForm.notes };
    setForm(f => ({ ...f, exercises: [...f.exercises, newEx] }));
    saveToBank({ name: exForm.name, sets: exForm.sets, reps: exForm.reps, weight: exForm.weight, notes: exForm.notes });
    setExForm({ name: "", sets: "4", perSerieReps: false, reps: "", serieReps: [], perSerieWeight: false, weight: "", serieWeights: [], notes: "" });
    setExSearch("");
    setAddingEx(false);
  };

  const fetchSuggestions = async () => {
    setLoadingSuggestions(true); setSuggestions(null);
    try { setSuggestions(await suggestExercises(form.type, suggestionGoal, form.exercises)); }
    catch {}
    setLoadingSuggestions(false);
  };

  const addSuggestedEx = (ex) => {
    const setsNum = ex.series || 4;
    const newEx = { id: Date.now(), name: ex.nombre, sets: String(setsNum), reps: ex.reps, serieReps: Array(setsNum).fill(ex.reps), perSerieReps: false, weight: ex.peso_inicial, notes: ex.razon, image: null };
    setForm(f => ({ ...f, exercises: [...f.exercises, newEx] }));
    saveToBank({ name: ex.nombre, sets: String(setsNum), reps: ex.reps, weight: ex.peso_inicial, notes: ex.razon });
  };

  // Progress modal
  if (progressEx && progressRoutine) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 400 }}>
        <div style={{ background: "#111120", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 18px 36px", width: "100%", maxWidth: 520, maxHeight: "85vh", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>📈 {progressEx}</div>
              <div style={{ fontSize: 11, color: "#7c3aed" }}>{progressRoutine.name}</div>
            </div>
            <button onClick={() => { setProgressEx(null); setProgressRoutine(null); }} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20 }}>✕</button>
          </div>
          <ExerciseProgressChart exName={progressEx} allData={allData} routineType={progressRoutine?.type} />
        </div>
      </div>
    );
  }

  // Editing form
  if (editing !== null) {
    const setsNum = Math.round(parseRange(exForm.sets)) || 1;
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }}>
        <div style={{ background: "#111120", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 18px 36px", width: "100%", maxWidth: 520, maxHeight: "93vh", overflowY: "auto" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", marginBottom: 18 }}>{editing === "new" ? "Nueva rutina" : "Editar rutina"}</div>

          <Lbl>Nombre</Lbl>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ej: Push A, Upper pesado…" style={{ ...inp, marginBottom: 14 }} autoFocus />

          <Lbl>Tipo</Lbl>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {allTypes.map(t => (
              <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))}
                style={{ padding: "5px 12px", borderRadius: 99, fontSize: 12, border: "none", cursor: "pointer", background: form.type === t ? "#7c3aed" : "#1a1a2e", color: form.type === t ? "#fff" : "#666" }}>
                {t}
              </button>
            ))}
            {addingCustomType ? (
              <div style={{ display: "flex", gap: 4 }}>
                <input value={newTypeName} onChange={e => setNewTypeName(e.target.value)} placeholder="Nuevo…" autoFocus
                  style={{ ...inp, width: 90, fontSize: 12, padding: "4px 8px" }}
                  onKeyDown={e => { if (e.key === "Enter" && newTypeName.trim()) { setCustomTypes(ct => [...ct, newTypeName.trim()]); setForm(f => ({ ...f, type: newTypeName.trim() })); setNewTypeName(""); setAddingCustomType(false); } }} />
                <button onClick={() => { if (newTypeName.trim()) { setCustomTypes(ct => [...ct, newTypeName.trim()]); setForm(f => ({ ...f, type: newTypeName.trim() })); setNewTypeName(""); setAddingCustomType(false); } }}
                  style={{ padding: "4px 8px", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", cursor: "pointer", fontSize: 12 }}>OK</button>
                <button onClick={() => setAddingCustomType(false)}
                  style={{ padding: "4px 8px", borderRadius: 8, border: "none", background: "none", color: "#555", cursor: "pointer", fontSize: 12 }}>✕</button>
              </div>
            ) : (
              <button onClick={() => setAddingCustomType(true)}
                style={{ padding: "5px 10px", borderRadius: 99, fontSize: 12, border: "1px dashed #2a2a3e", background: "none", color: "#555", cursor: "pointer" }}>+ tipo</button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 11, color: "#444" }}>Duración estimada</span>
            <input type="text" value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} placeholder="60"
              style={{ ...inp, width: 60, fontSize: 12, padding: "4px 8px" }} />
            <span style={{ fontSize: 11, color: "#444" }}>min (para estimar calorías)</span>
          </div>

          <Lbl>Ejercicios</Lbl>
          {form.exercises.map((ex, i) => (
            <div key={ex.id} style={{ background: "#1a1a2e", borderRadius: 12, padding: "12px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <button onClick={() => i > 0 && moveEx(i, -1)} disabled={i === 0}
                    style={{ background: "none", border: "none", color: i === 0 ? "#2a2a3e" : "#7c3aed", cursor: i === 0 ? "default" : "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>▲</button>
                  <button onClick={() => i < form.exercises.length - 1 && moveEx(i, 1)} disabled={i === form.exercises.length - 1}
                    style={{ background: "none", border: "none", color: i === form.exercises.length - 1 ? "#2a2a3e" : "#7c3aed", cursor: i === form.exercises.length - 1 ? "default" : "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>▼</button>
                </div>
                <input value={ex.name} onChange={e => updateEx(i, "name", e.target.value)}
                  style={{ flex: 1, background: "none", border: "none", color: "#e2e8f0", fontSize: 13, fontWeight: 700, outline: "none", padding: "2px 0", fontFamily: "inherit" }} />
                <button onClick={() => setForm(f => ({ ...f, exercises: f.exercises.filter((_, j) => j !== i) }))}
                  style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 15 }}>✕</button>
              </div>

              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 9, color: "#555", marginBottom: 2 }}>Series</div>
                <input type="text" value={ex.sets || ""} onChange={e => updateEx(i, "sets", e.target.value)} placeholder="4" style={{ ...inp, fontSize: 12 }} />
              </div>

              {/* Reps */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 9, color: "#555" }}>Repeticiones</div>
                  <button onClick={() => updateEx(i, "perSerieReps", !ex.perSerieReps)}
                    style={{ fontSize: 10, color: "#7c3aed", background: "none", border: "none", cursor: "pointer" }}>
                    {ex.perSerieReps ? "← Igual para todas" : "Por serie →"}
                  </button>
                </div>
                {ex.perSerieReps ? (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: Math.round(parseRange(ex.sets)) || 1 }, (_, si) => (
                      <div key={si} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "#444", marginBottom: 2 }}>S{si + 1}</div>
                        <input type="text" value={(ex.serieReps || [])[si] || ""} placeholder="—"
                          onChange={e => { const sr = [...(ex.serieReps || Array(Math.round(parseRange(ex.sets)) || 1).fill(""))]; sr[si] = e.target.value; updateEx(i, "serieReps", sr); }}
                          style={{ ...inp, width: 44, fontSize: 12, padding: "4px 6px", textAlign: "center" }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <input type="text" value={ex.reps || ""} onChange={e => updateEx(i, "reps", e.target.value)} placeholder="10" style={{ ...inp, fontSize: 12 }} />
                )}
              </div>

              {/* Weight */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 9, color: "#555" }}>Peso (kg)</div>
                  <button onClick={() => updateEx(i, "perSerieWeight", !ex.perSerieWeight)}
                    style={{ fontSize: 10, color: "#7c3aed", background: "none", border: "none", cursor: "pointer" }}>
                    {ex.perSerieWeight ? "← Igual para todas" : "Por serie →"}
                  </button>
                </div>
                {ex.perSerieWeight ? (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: Math.round(parseRange(ex.sets)) || 1 }, (_, si) => (
                      <div key={si} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "#444", marginBottom: 2 }}>S{si + 1}</div>
                        <input type="text" value={(ex.serieWeights || [])[si] || ""} placeholder="—"
                          onChange={e => { const sw = [...(ex.serieWeights || Array(Math.round(parseRange(ex.sets)) || 1).fill(""))]; sw[si] = e.target.value; updateEx(i, "serieWeights", sw); }}
                          style={{ ...inp, width: 44, fontSize: 12, padding: "4px 6px", textAlign: "center" }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <input value={ex.weight || ""} onChange={e => updateEx(i, "weight", e.target.value)} placeholder="60-70" style={{ ...inp, fontSize: 12 }} />
                )}
              </div>

              <input value={ex.notes || ""} onChange={e => updateEx(i, "notes", e.target.value)} placeholder="Notas opcionales…" style={{ ...inp, fontSize: 12, marginBottom: 6 }} />
              <button onClick={() => { setProgressEx(ex.name); setProgressRoutine({ ...form }); }}
                style={{ background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 11, padding: 0 }}>📈 Ver progreso</button>
            </div>
          ))}

          {addingEx ? (
            <div style={{ background: "#1a1a2e", borderRadius: 12, padding: 14, marginBottom: 12, border: "1px solid #7c3aed33" }}>
              {/* Nombre con banco de ejercicios */}
              <div style={{ position: "relative", marginBottom: 10 }}>
                <input
                  value={exForm.name}
                  onChange={e => { setExForm(f => ({ ...f, name: e.target.value })); setExSearch(e.target.value); setShowBankDropdown(true); }}
                  onFocus={() => setShowBankDropdown(true)}
                  onBlur={() => setTimeout(() => setShowBankDropdown(false), 150)}
                  placeholder="Nombre del ejercicio…" style={{ ...inp, marginBottom: 0 }} autoFocus />
                {showBankDropdown && bankMatches.length > 0 && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#0f0f1e", border: "1px solid #7c3aed44", borderRadius: 10, zIndex: 50, overflow: "hidden", marginTop: 2 }}>
                    {bankMatches.map((e, i) => (
                      <button key={i} onMouseDown={() => {
                        setExForm(f => ({ ...f, name: e.name, sets: e.sets || f.sets, reps: e.reps || f.reps, weight: e.weight || f.weight, notes: e.notes || f.notes }));
                        setExSearch(e.name);
                        setShowBankDropdown(false);
                      }} style={{ display: "block", width: "100%", padding: "9px 12px", background: "none", border: "none", borderBottom: i < bankMatches.length - 1 ? "1px solid #1a1a2e" : "none", color: "#e2e8f0", cursor: "pointer", textAlign: "left", fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{e.name}</span>
                        <span style={{ fontSize: 11, color: "#555", marginLeft: 8 }}>{[e.sets && `${e.sets} series`, e.reps && `${e.reps} reps`, e.weight && `${e.weight}kg`].filter(Boolean).join(" · ")}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: "#555", marginBottom: 2 }}>Series</div>
                <input type="text" value={exForm.sets} onChange={e => setExForm(f => ({ ...f, sets: e.target.value, serieReps: [], serieWeights: [] }))} placeholder="4" style={{ ...inp, fontSize: 12 }} />
              </div>

              {/* Reps */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 9, color: "#555" }}>Repeticiones</div>
                  <button onClick={() => setExForm(f => ({ ...f, perSerieReps: !f.perSerieReps, serieReps: [] }))}
                    style={{ fontSize: 10, color: "#7c3aed", background: "none", border: "none", cursor: "pointer" }}>
                    {exForm.perSerieReps ? "← Igual para todas" : "Por serie →"}
                  </button>
                </div>
                {exForm.perSerieReps ? (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: setsNum }, (_, si) => (
                      <div key={si} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "#444", marginBottom: 2 }}>S{si + 1}</div>
                        <input type="text" value={exForm.serieReps[si] || ""} placeholder="—"
                          onChange={e => { const sr = [...exForm.serieReps]; sr[si] = e.target.value; setExForm(f => ({ ...f, serieReps: sr })); }}
                          style={{ ...inp, width: 44, fontSize: 12, padding: "4px 6px", textAlign: "center" }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <input type="text" value={exForm.reps} onChange={e => setExForm(f => ({ ...f, reps: e.target.value }))} placeholder="10" style={{ ...inp, fontSize: 12 }} />
                )}
              </div>

              {/* Weight */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 9, color: "#555" }}>Peso (kg)</div>
                  <button onClick={() => setExForm(f => ({ ...f, perSerieWeight: !f.perSerieWeight, serieWeights: [] }))}
                    style={{ fontSize: 10, color: "#7c3aed", background: "none", border: "none", cursor: "pointer" }}>
                    {exForm.perSerieWeight ? "← Igual para todas" : "Por serie →"}
                  </button>
                </div>
                {exForm.perSerieWeight ? (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: setsNum }, (_, si) => (
                      <div key={si} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "#444", marginBottom: 2 }}>S{si + 1}</div>
                        <input type="text" value={exForm.serieWeights[si] || ""} placeholder="—"
                          onChange={e => { const sw = [...exForm.serieWeights]; sw[si] = e.target.value; setExForm(f => ({ ...f, serieWeights: sw })); }}
                          style={{ ...inp, width: 44, fontSize: 12, padding: "4px 6px", textAlign: "center" }} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <input value={exForm.weight} onChange={e => setExForm(f => ({ ...f, weight: e.target.value }))} placeholder="60-70" style={{ ...inp, fontSize: 12 }} />
                )}
              </div>

              <input value={exForm.notes} onChange={e => setExForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notas opcionales…" style={{ ...inp, fontSize: 12, marginBottom: 10 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setAddingEx(false); setExForm({ name: "", sets: "4", perSerieReps: false, reps: "", serieReps: [], perSerieWeight: false, weight: "", serieWeights: [], notes: "" }); }}
                  style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid #2a2a3e", background: "none", color: "#666", cursor: "pointer" }}>Cancelar</button>
                <button onClick={addEx} style={{ flex: 2, padding: "8px 0", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Agregar ejercicio</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddingEx(true)} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: "1px dashed #2a2a3e", background: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13, marginBottom: 14 }}>
              + Agregar ejercicio
            </button>
          )}

          <div style={{ background: "#0a0a14", border: "1px solid #7c3aed22", borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 8 }}>✨ Sugerencias de IA</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input value={suggestionGoal} onChange={e => setSuggestionGoal(e.target.value)} placeholder="Objetivo (ej: volumen, fuerza…)" style={{ ...inp, fontSize: 12, flex: 1 }} />
              <button onClick={fetchSuggestions} disabled={loadingSuggestions}
                style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", cursor: "pointer", fontSize: 12, opacity: loadingSuggestions ? 0.6 : 1 }}>
                {loadingSuggestions ? "…" : "Sugerir"}
              </button>
            </div>
            {suggestions && (suggestions.ejercicios || []).map((ex, i) => (
              <div key={i} style={{ background: "#111120", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{ex.nombre}</div>
                    <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 1 }}>{ex.series}s × {ex.reps} · {ex.peso_inicial}</div>
                    <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{ex.musculo_principal} · {ex.razon}</div>
                  </div>
                  <button onClick={() => addSuggestedEx(ex)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "#7c3aed22", color: "#7c3aed", cursor: "pointer", fontSize: 11, marginLeft: 8 }}>+ Add</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setEditing(null)} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #2a2a3e", background: "none", color: "#888", cursor: "pointer" }}>Cancelar</button>
            <button onClick={saveRoutine} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Guardar rutina</button>
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 300 }}>
      <div style={{ background: "#111120", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 18px 36px", width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>🏋️ Mis rutinas</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        {list.length === 0 && <div style={{ fontSize: 13, color: "#444", marginBottom: 12 }}>No hay rutinas guardadas todavía.</div>}
        {list.map(r => (
          <div key={r.id} style={{ background: "#1a1a2e", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: (r.exercises || []).length > 0 ? 10 : 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{r.name}</div>
                <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 2 }}>{r.type} · {(r.exercises || []).length} ejercicios</div>
              </div>
              <button onClick={() => startEdit(r)} style={{ background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13 }}>Editar</button>
              <button onClick={() => { const nl = list.filter(x => x.id !== r.id); setList(nl); onSave(nl); }} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>
            {(r.exercises || []).length > 0 && (
              <div style={{ borderTop: "1px solid #2a2a3e", paddingTop: 8 }}>
                {r.exercises.map(ex => (
                  <div key={ex.id} style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 5, marginBottom: 5, borderBottom: "1px solid #1a1a2e" }}>
                    {ex.image && <img src={ex.image} alt={ex.name} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} onError={e => { e.target.style.display = "none"; }} />}
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12, color: "#e2e8f0" }}>{ex.name}</span>
                      <span style={{ fontSize: 11, color: "#555", marginLeft: 8 }}>
                        {ex.sets && `${ex.sets}s`}
                        {ex.perSerieReps && ex.serieReps ? ` × ${ex.serieReps.filter(Boolean).join("/")}r` : ex.reps ? ` × ${ex.reps}r` : ""}
                        {ex.perSerieWeight && ex.serieWeights ? ` · ${ex.serieWeights.filter(Boolean).join("/")}kg` : ex.weight ? ` · ${ex.weight}kg` : ""}
                      </span>
                    </div>
                    <button onClick={() => { setProgressEx(ex.name); setProgressRoutine(r); }}
                      style={{ background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 11 }}>📈</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        <button onClick={startNew} style={{ width: "100%", padding: "10px 0", borderRadius: 10, border: "1px dashed #7c3aed44", background: "#7c3aed09", color: "#7c3aed", cursor: "pointer", fontSize: 13, marginBottom: 12 }}>
          + Nueva rutina
        </button>
        <button onClick={() => { onSave(list); onClose(); }} style={{ width: "100%", padding: "11px 0", borderRadius: 10, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>
          Guardar y cerrar
        </button>
      </div>
    </div>
  );
}


// ── Exercise Log ──────────────────────────────────────────────────

function ExerciseLog({ exercises, onChange, allData }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""); const [sets, setSets] = useState(""); const [reps, setReps] = useState(""); const [weightRange, setWeightRange] = useState(""); const [notes, setNotes] = useState("");

  const getRecord = (n) => {
    let best = null;
    Object.values(allData).forEach(day => (day.exercises || []).forEach(ex => {
      if (ex.name?.toLowerCase() === n?.toLowerCase()) {
        const w = ex.weightRange ? parseRange(ex.weightRange) : null;
        if (w && (!best || w > best)) best = w;
      }
    }));
    return best;
  };

  const handleAdd = () => {
    if (!name.trim()) return;
    onChange([...exercises, { id: Date.now(), name: name.trim(), sets, reps, weightRange, notes }]);
    setName(""); setSets(""); setReps(""); setWeightRange(""); setNotes(""); setAdding(false);
  };

  const record = name.trim() ? getRecord(name.trim()) : null;
  const currentMax = weightRange ? parseRange(weightRange) : null;
  const isPR = record && currentMax && currentMax > record;

  return (
    <div>
      {exercises.length === 0 && !adding && <div style={{ fontSize: 13, color: "#444", marginBottom: 8 }}>Sin ejercicios cargados.</div>}
      {exercises.map(ex => {
        const pr = getRecord(ex.name);
        const exMax = ex.weightRange ? parseRange(ex.weightRange) : null;
        const isThisPR = exMax && pr && exMax >= pr;
        return (
          <div key={ex.id} style={{ background: "#1a1a2e", border: `1px solid ${isThisPR ? "#facc1544" : "#2a2a3e"}`, borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{ex.name}</span>
                  {isThisPR && <span style={{ fontSize: 10, background: "#facc1422", color: "#facc14", borderRadius: 99, padding: "1px 6px" }}>🏆 PR</span>}
                </div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{[ex.sets && `${ex.sets} series`, ex.reps && `${ex.reps} reps`, ex.weightRange && `${ex.weightRange}kg`].filter(Boolean).join(" · ") || "Sin detalle"}</div>
                {ex.notes && <div style={{ fontSize: 11, color: "#555", marginTop: 2, fontStyle: "italic" }}>{ex.notes}</div>}
                {pr && !isThisPR && <div style={{ fontSize: 10, color: "#7c3aed", marginTop: 2 }}>📈 Récord: {pr}kg</div>}
                {ex.targetWeight && <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>🎯 Objetivo: {[ex.targetSets && `${ex.targetSets}s`, ex.targetReps && `${ex.targetReps}r`, `${ex.targetWeight}kg`].filter(Boolean).join(" × ")}</div>}
              </div>
              <button onClick={() => onChange(exercises.filter(e => e.id !== ex.id))} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>
          </div>
        );
      })}
      {adding ? (
        <div style={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 12, padding: 14, marginTop: 6 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Ejercicio…" style={{ ...inp, marginBottom: 8 }} autoFocus />
          {record && <div style={{ fontSize: 11, color: isPR ? "#facc14" : "#7c3aed", marginBottom: 8, padding: "4px 8px", background: isPR ? "#facc1411" : "#7c3aed11", borderRadius: 6 }}>{isPR ? `🏆 ¡Nuevo PR! Anterior: ${record}kg` : `📈 Récord anterior: ${record}kg`}</div>}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 10, color: "#555", marginBottom: 3 }}>Series</div><input type="text" value={sets} onChange={e => setSets(e.target.value)} placeholder="4" style={inp} /></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 10, color: "#555", marginBottom: 3 }}>Reps</div><input type="text" value={reps} onChange={e => setReps(e.target.value)} placeholder="10" style={inp} /></div>
            <div style={{ flex: 1.4 }}><div style={{ fontSize: 10, color: "#555", marginBottom: 3 }}>Peso (ej: 60-70)</div><input value={weightRange} onChange={e => setWeightRange(e.target.value)} placeholder="60-70" style={inp} /></div>
          </div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notas opcionales…" style={{ ...inp, marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { setAdding(false); setName(""); setSets(""); setReps(""); setWeightRange(""); setNotes(""); }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid #2a2a3e", background: "none", color: "#666", cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleAdd} style={{ flex: 2, padding: "8px 0", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>{isPR ? "💪 Agregar (PR)" : "Agregar"}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: "1px dashed #2a2a3e", background: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13, marginTop: exercises.length > 0 ? 4 : 0 }}>
          + Agregar ejercicio
        </button>
      )}
    </div>
  );
}

// ── Meal Card with Edit ───────────────────────────────────────────

function MealCard({ meal, onDelete, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(meal.name);
  const [editTime, setEditTime] = useState(meal.mealTime || "");
  const [reanalyzing, setReanalyzing] = useState(false);

  const timeColor = { "Pre-entreno": "#60a5fa", "Post-entreno": "#4ade80", "Desayuno": "#facc15", "Almuerzo": "#fb923c", "Cena": "#a78bfa", "Merienda": "#f472b6", "Snack": "#888" };

  const saveEdit = async () => {
    const updated = { ...meal, name: editName, mealTime: editTime };
    onUpdate(updated);
    setEditing(false);
    if (editName !== meal.name) {
      setReanalyzing(true);
      try {
        const nutrition = await analyzeMeal(editName);
        onUpdate({ ...updated, nutrition });
      } catch {}
      setReanalyzing(false);
    }
  };

  if (editing) {
    return (
      <div style={{ background: "#1a1a2e", border: "1px solid #7c3aed44", borderRadius: 10, padding: "12px", marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Momento</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          {MEAL_TIMES.map(t => (
            <button key={t} onClick={() => setEditTime(t === editTime ? "" : t)}
              style={{ padding: "4px 10px", borderRadius: 99, fontSize: 11, border: "none", cursor: "pointer", background: editTime === t ? "#7c3aed" : "#1e1e2e", color: editTime === t ? "#fff" : "#777" }}>
              {t}
            </button>
          ))}
        </div>
        <textarea value={editName} onChange={e => setEditName(e.target.value)}
          style={{ ...inp, minHeight: 56, resize: "none", marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setEditing(false)} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "1px solid #2a2a3e", background: "none", color: "#666", cursor: "pointer" }}>Cancelar</button>
          <button onClick={saveEdit} style={{ flex: 2, padding: "7px 0", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Guardar y reanálizar</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 8, cursor: meal.nutrition ? "pointer" : "default" }} onClick={() => meal.nutrition && !editing && setExpanded(e => !e)}>
        {meal.photo && <img src={meal.photo} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {meal.mealTime && <div style={{ fontSize: 10, color: timeColor[meal.mealTime] || "#888", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{meal.mealTime}</div>}
          <div style={{ fontSize: 13, color: "#e2e8f0" }}>{meal.name}</div>
          {reanalyzing && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Re-analizando…</div>}
          {!reanalyzing && meal.nutrition && <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 2 }}>{meal.nutrition.calorias} kcal · {meal.nutrition.proteinas_g}g prot</div>}
          {meal.loading && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Analizando…</div>}
          {meal.error && <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>No se pudo analizar</div>}
        </div>
        <button onClick={e => { e.stopPropagation(); setEditing(true); setEditName(meal.name); setEditTime(meal.mealTime || ""); }} style={{ background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 12, padding: "0 4px", flexShrink: 0 }}>✏️</button>
        {meal.nutrition && <span style={{ fontSize: 11, color: "#333", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>}
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 16, padding: "0 2px", flexShrink: 0 }}>✕</button>
      </div>
      {expanded && meal.nutrition && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid #2a2a3e", background: "#13131f" }}>
          <div style={{ display: "flex", marginBottom: 8 }}>
            <NBadge label="Calorías" value={meal.nutrition.calorias} color="#facc15" />
            <NBadge label="Proteína" value={`${meal.nutrition.proteinas_g}g`} color="#4ade80" />
            <NBadge label="Carbos" value={`${meal.nutrition.carbos_g}g`} color="#60a5fa" />
            <NBadge label="Grasas" value={`${meal.nutrition.grasas_g}g`} color="#fb923c" />
          </div>
          {meal.nutrition.nota && <div style={{ fontSize: 11, color: "#666", borderTop: "1px solid #2a2a3e", paddingTop: 6 }}>💡 {meal.nutrition.nota}</div>}
        </div>
      )}
    </div>
  );
}

function AddMealModal({ onAdd, onClose, recentMeals = [] }) {
  const [step, setStep] = useState("input");
  const [name, setName] = useState("");
  const [mealTime, setMealTime] = useState("");
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [checking, setChecking] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoBase64, setPhotoBase64] = useState(null);

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotoPreview(ev.target.result);
      setPhotoBase64(ev.target.result.split(",")[1]);
    };
    reader.readAsDataURL(file);
  };

  const handleContinue = () => {
    const t = name.trim();
    if (!t) return;
    onAdd({ name: t, mealTime, aclaraciones: "", photoBase64 });
    onClose();
  };

  const handleConfirmWithAnswers = () => {
    const aclaraciones = questions.map((q, i) => `${q}: ${answers[i] || "no especificado"}`).join(". ");
    onAdd({ name: name.trim(), mealTime, aclaraciones, photoBase64 });
    onClose();
  };

  const handleSkipClarify = () => {
    onAdd({ name: name.trim(), mealTime, aclaraciones: "", photoBase64 });
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "#111120", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 18px 36px", width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>

        {step === "input" && (<>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", marginBottom: 14 }}>Registrar comida</div>

          {recentMeals.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>Recientes — tocá para rellenar</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {recentMeals.slice(0, 8).map((m, i) => (
                  <button key={i} onClick={() => setName(m)}
                    style={{ padding: "4px 10px", borderRadius: 99, fontSize: 11, border: `1px solid ${name === m ? "#7c3aed" : "#2a2a3e"}`, background: name === m ? "#7c3aed" : "#1a1a2e", color: name === m ? "#fff" : "#777", cursor: "pointer", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Lbl>Momento del día</Lbl>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {MEAL_TIMES.map(t => <button key={t} onClick={() => setMealTime(mealTime === t ? "" : t)} style={{ padding: "5px 12px", borderRadius: 99, fontSize: 12, border: "none", cursor: "pointer", background: mealTime === t ? "#7c3aed" : "#1a1a2e", color: mealTime === t ? "#fff" : "#666" }}>{t}</button>)}
          </div>
          <Lbl>Descripción</Lbl>
          <textarea value={name} onChange={e => setName(e.target.value)}
            placeholder="Ej: 2 huevos revueltos, 150g pechuga, arroz integral…"
            style={{ ...inp, minHeight: 72, resize: "none", marginBottom: 6 }} />
          <div style={{ fontSize: 11, color: "#555", marginBottom: 12 }}>Cuanto más detalle ponés (gramaje, cocción, salsas), más preciso el análisis.</div>

          {/* Foto de la comida */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <Lbl style={{ marginBottom: 0 }}>Foto <span style={{ color: "#555", fontWeight: 400 }}>(mejora la precisión)</span></Lbl>
              <span style={{ fontSize: 10, color: "#f59e0b", background: "#f59e0b11", border: "1px solid #f59e0b33", borderRadius: 99, padding: "2px 8px" }}>Funciona al migrar a hosting propio</span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <div style={{ padding: "8px 14px", borderRadius: 8, border: "1px dashed #3a3a5e", background: "#1a1a2e", color: "#7c3aed", fontSize: 13, fontWeight: 600 }}>
                📷 {photoPreview ? "Cambiar foto" : "Subir foto"}
              </div>
              <input type="file" accept="image/*" onChange={handlePhoto} style={{ display: "none" }} />
              {photoPreview && <span style={{ fontSize: 11, color: "#4ade80" }}>✓ Foto cargada</span>}
            </label>
            {photoPreview && (
              <div style={{ marginTop: 8, position: "relative", display: "inline-block" }}>
                <img src={photoPreview} alt="preview" style={{ width: 120, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid #7c3aed44" }} />
                <button onClick={() => { setPhotoPreview(null); setPhotoBase64(null); }} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 99, background: "#f87171", border: "none", color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #2a2a3e", background: "none", color: "#888", cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleContinue} disabled={checking || !name.trim()} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: checking ? "#4a2a9e" : "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
              {checking ? "Analizando…" : "Continuar →"}
            </button>
          </div>
        </>)}

        {step === "clarify" && (<>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Precisar la comida</div>
          <div style={{ fontSize: 12, color: "#7c3aed", marginBottom: 16 }}>La IA necesita un poco más de info para contar bien las calorías</div>
          {questions.map((q, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <Lbl>{q}</Lbl>
              <input value={answers[i]} onChange={e => { const a = [...answers]; a[i] = e.target.value; setAnswers(a); }}
                placeholder="Tu respuesta…"
                style={{ ...inp, marginBottom: 0 }} />
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={handleSkipClarify} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #2a2a3e", background: "none", color: "#666", cursor: "pointer", fontSize: 13 }}>Saltar</button>
            <button onClick={handleConfirmWithAnswers} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>Registrar + analizar</button>
          </div>
        </>)}

      </div>
    </div>
  );
}

function MacroBar({ label, current, goal, color, unit = "g" }) {
  const pct = goal > 0 ? Math.min(current / goal, 1) : 0;
  const remaining = goal > 0 ? Math.max(goal - current, 0) : null;
  const over = goal > 0 && current > goal;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
          <span style={{ fontSize: 12, color: "#888" }}>{label}</span>
        </div>
        <div style={{ display: "flex", align: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color }}>{Math.round(current)}{unit}</span>
          {goal > 0 && (
            <span style={{ fontSize: 11, color: over ? "#f87171" : remaining === 0 ? "#4ade80" : "#555" }}>
              {over ? `+${Math.round(current - goal)} exceso` : remaining === 0 ? "✓ meta" : `faltan ${Math.round(remaining)}${unit}`}
            </span>
          )}
          {goal > 0 && <span style={{ fontSize: 11, color: "#444" }}>/ {goal}{unit}</span>}
        </div>
      </div>
      <div style={{ height: 6, background: "#1e1e2e", borderRadius: 99 }}>
        <div style={{ height: 6, width: `${pct * 100}%`, background: over ? "#f87171" : pct >= 1 ? "#4ade80" : color, borderRadius: 99, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

function DailyNutrition({ meals, settings, burnedCal }) {
  const withNut = meals.filter(m => m.nutrition);
  if (withNut.length === 0) return null;

  const t = withNut.reduce((a, m) => ({
    cal: a.cal + (m.nutrition.calorias || 0),
    prot: a.prot + (m.nutrition.proteinas_g || 0),
    carbs: a.carbs + (m.nutrition.carbos_g || 0),
    fat: a.fat + (m.nutrition.grasas_g || 0)
  }), { cal: 0, prot: 0, carbs: 0, fat: 0 });

  const protGoal = parseRange(settings.proteinGoal) || 0;
  const carbsGoal = parseRange(settings.carbsGoal) || 0;
  const fatGoal = parseRange(settings.fatGoal) || 0;
  const tdee = parseRange(settings.tdee) || 0;
  const effectiveTDEE = tdee + (burnedCal || 0);
  const deficit = effectiveTDEE > 0 ? effectiveTDEE - Math.round(t.cal) : null;
  const lowCal = Math.round(t.cal) < 1200 && withNut.length >= 2;

  const protPct = t.cal > 0 ? Math.round((t.prot * 4 / t.cal) * 100) : 0;
  const carbPct = t.cal > 0 ? Math.round((t.carbs * 4 / t.cal) * 100) : 0;
  const fatPct = t.cal > 0 ? Math.round((t.fat * 9 / t.cal) * 100) : 0;
  const noGoalsSet = !protGoal && !carbsGoal && !fatGoal;

  // What's missing
  const missing = [
    protGoal > 0 && t.prot < protGoal && { label: "Proteína", amount: Math.round(protGoal - t.prot), unit: "g", color: "#4ade80" },
    carbsGoal > 0 && t.carbs < carbsGoal && { label: "Carbos", amount: Math.round(carbsGoal - t.carbs), unit: "g", color: "#60a5fa" },
    fatGoal > 0 && t.fat < fatGoal && { label: "Grasas", amount: Math.round(fatGoal - t.fat), unit: "g", color: "#fb923c" },
  ].filter(Boolean);

  return (
    <div style={{ background: "#0a0a14", border: `1px solid ${lowCal ? "#f8712233" : "#7c3aed33"}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
      {lowCal && <div style={{ fontSize: 11, color: "#fb923c", background: "#fb923c11", borderRadius: 6, padding: "6px 10px", marginBottom: 10 }}>⚠️ Menos de 1200 kcal — déficit muy agresivo.</div>}

      {/* Calorie header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: "#7c3aed", letterSpacing: 0.5, marginBottom: 2 }}>
            Total del día{burnedCal > 0 ? ` · +${burnedCal} kcal gym` : ""}
          </div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#facc15", lineHeight: 1.1 }}>
            {Math.round(t.cal)} <span style={{ fontSize: 13, color: "#555", fontWeight: 400 }}>kcal</span>
          </div>
        </div>
        {deficit !== null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#555" }}>vs TDEE{burnedCal > 0 ? " ajustado" : ""}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: deficit > 0 ? "#4ade80" : "#f87171" }}>
              {deficit > 0 ? `−${deficit}` : `+${Math.abs(deficit)}`} kcal
            </div>
          </div>
        )}
      </div>

      {effectiveTDEE > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ height: 5, background: "#1e1e2e", borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: 5, width: `${Math.min(t.cal / effectiveTDEE, 1.05) * 100}%`, background: deficit > 0 ? "#4ade80" : "#f87171", borderRadius: 99, transition: "width 0.4s" }} />
          </div>
        </div>
      )}

      {/* Macro bars */}
      <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 12 }}>
        <MacroBar label="Proteína" current={t.prot} goal={protGoal} color="#4ade80" />
        <MacroBar label="Carbohidratos" current={t.carbs} goal={carbsGoal} color="#60a5fa" />
        <MacroBar label="Grasas" current={t.fat} goal={fatGoal} color="#fb923c" />
      </div>

      {/* Macro split bar */}
      <div style={{ marginTop: 8, marginBottom: missing.length > 0 ? 12 : 0 }}>
        <div style={{ height: 4, background: "#1e1e2e", borderRadius: 99, overflow: "hidden", display: "flex", marginBottom: 4 }}>
          <div style={{ height: 4, width: `${protPct}%`, background: "#4ade80" }} />
          <div style={{ height: 4, width: `${carbPct}%`, background: "#60a5fa" }} />
          <div style={{ height: 4, width: `${fatPct}%`, background: "#fb923c" }} />
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 10, color: "#444" }}>
          <span>🟢 {protPct}%</span><span>🔵 {carbPct}%</span><span>🟠 {fatPct}%</span>
        </div>
      </div>

      {/* What's missing summary */}
      {missing.length > 0 && (
        <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>Te falta para cerrar el día:</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {missing.map((m, i) => (
              <div key={i} style={{ background: `${m.color}14`, border: `1px solid ${m.color}33`, borderRadius: 8, padding: "4px 10px", display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: m.color }}>{m.amount}{m.unit}</span>
                <span style={{ fontSize: 11, color: "#666" }}>{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {noGoalsSet && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#555", fontStyle: "italic" }}>
          Configurá tus metas de macros en ⚙️ para ver el progreso.
        </div>
      )}
    </div>
  );
}

function MealRecommendations({ meals, settings, burnedCal }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  if (meals.length === 0) return null;

  // Calculate remaining macros to show in button
  const withNut = meals.filter(m => m.nutrition);
  const t = withNut.reduce((a, m) => ({ cal: a.cal + (m.nutrition.calorias || 0), prot: a.prot + (m.nutrition.proteinas_g || 0), carbs: a.carbs + (m.nutrition.carbos_g || 0), fat: a.fat + (m.nutrition.grasas_g || 0) }), { cal: 0, prot: 0, carbs: 0, fat: 0 });
  const protGoal = parseRange(settings.proteinGoal) || 0;
  const carbsGoal = parseRange(settings.carbsGoal) || 0;
  const fatGoal = parseRange(settings.fatGoal) || 0;
  const tdee = parseRange(settings.tdee) || 0;
  const effectiveTDEE = tdee + (burnedCal || 0);

  const remaining = {
    cal: effectiveTDEE > 0 ? Math.max(effectiveTDEE - Math.round(t.cal), 0) : null,
    prot: protGoal > 0 ? Math.max(protGoal - Math.round(t.prot), 0) : null,
    carbs: carbsGoal > 0 ? Math.max(carbsGoal - Math.round(t.carbs), 0) : null,
    fat: fatGoal > 0 ? Math.max(fatGoal - Math.round(t.fat), 0) : null,
  };

  const fetch_ = async () => {
    setLoading(true); setError(false);
    try { setData(await getMealRecommendations(meals, settings, burnedCal)); }
    catch { setError(true); }
    setLoading(false);
  };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid #1e1e2e", paddingTop: 12 }}>
      {!data && !loading && (
        <div>
          {/* Remaining summary before button */}
          {(remaining.prot !== null || remaining.carbs !== null || remaining.fat !== null) && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {remaining.prot !== null && remaining.prot > 0 && <span style={{ fontSize: 11, color: "#4ade80" }}>🟢 {remaining.prot}g prot</span>}
              {remaining.carbs !== null && remaining.carbs > 0 && <span style={{ fontSize: 11, color: "#60a5fa" }}>🔵 {remaining.carbs}g carbos</span>}
              {remaining.fat !== null && remaining.fat > 0 && <span style={{ fontSize: 11, color: "#fb923c" }}>🟠 {remaining.fat}g grasas</span>}
              {remaining.cal !== null && remaining.cal > 0 && <span style={{ fontSize: 11, color: "#facc15" }}>🔥 {remaining.cal} kcal</span>}
            </div>
          )}
          <button onClick={fetch_} style={{ width: "100%", padding: "9px 0", borderRadius: 10, border: "1px solid #7c3aed44", background: "#7c3aed11", color: "#7c3aed", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            ✨ ¿Qué como para cerrar los macros?
          </button>
        </div>
      )}
      {loading && <div style={{ textAlign: "center", padding: "16px 0", fontSize: 13, color: "#555" }}>Analizando qué te falta…</div>}
      {error && <div style={{ fontSize: 12, color: "#f87171", textAlign: "center" }}>Error. <button onClick={fetch_} style={{ color: "#7c3aed", background: "none", border: "none", cursor: "pointer" }}>Reintentar</button></div>}
      {data && (
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, fontStyle: "italic" }}>{data.estado}</div>
          {(data.recomendaciones || []).map((r, i) => (
            <div key={i} style={{ background: "#1a1a2e", borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{r.nombre}</div>
                  <div style={{ fontSize: 12, color: "#777", marginTop: 2 }}>{r.descripcion}</div>
                  <div style={{ fontSize: 11, color: "#555", marginTop: 3, fontStyle: "italic" }}>{r.razon}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 10 }}>
                  <div style={{ fontSize: 12, color: "#facc15", fontWeight: 700 }}>{r.calorias_aprox} kcal</div>
                  <div style={{ fontSize: 11, color: "#4ade80" }}>{r.proteinas_aprox}g prot</div>
                  {r.carbos_aprox && <div style={{ fontSize: 11, color: "#60a5fa" }}>{r.carbos_aprox}g carbos</div>}
                </div>
              </div>
            </div>
          ))}
          <button onClick={() => setData(null)} style={{ width: "100%", padding: "5px 0", borderRadius: 8, border: "none", background: "none", color: "#333", cursor: "pointer", fontSize: 11, marginTop: 2 }}>Ocultar</button>
        </div>
      )}
    </div>
  );
}


// ── Photo compare ─────────────────────────────────────────────────

function PhotoSection({ photos, onChange }) {
  const fileRef = useRef();
  const handleFile = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => onChange([...photos, { id: Date.now(), data: ev.target.result, date: todayKey() }]); r.readAsDataURL(f); };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: photos.length > 0 ? 8 : 0 }}>
        {photos.map(p => (
          <div key={p.id} style={{ position: "relative" }}>
            <img src={p.data} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #2a2a3e" }} />
            <button onClick={() => onChange(photos.filter(x => x.id !== p.id))} style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#f87171", border: "none", color: "#fff", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
          </div>
        ))}
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
      <button onClick={() => fileRef.current.click()} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: "1px dashed #2a2a3e", background: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13 }}>+ Foto de progreso</button>
    </div>
  );
}

function PhotoCompare({ allData }) {
  const allPhotos = [];
  Object.entries(allData).forEach(([date, day]) => (day.photos || []).forEach(p => allPhotos.push({ ...p, date })));
  allPhotos.sort((a, b) => a.date.localeCompare(b.date));
  const [a, setA] = useState(null); const [b, setB] = useState(null);
  if (allPhotos.length < 2) return <div style={{ fontSize: 13, color: "#444", textAlign: "center", padding: "20px 0" }}>Necesitás al menos 2 fotos de progreso para comparar.</div>;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {[{ val: a, set: setA, label: "Antes" }, { val: b, set: setB, label: "Después" }].map(({ val, set, label }) => (
          <div key={label} style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>{label}</div>
            <select value={val || ""} onChange={e => set(e.target.value || null)}
              style={{ ...inp, marginBottom: 6 }}>
              <option value="">Elegir foto…</option>
              {allPhotos.map(p => <option key={p.id} value={p.id}>{formatDate(p.date)}</option>)}
            </select>
            {val && (() => { const p = allPhotos.find(x => x.id === parseInt(val) || x.id === val); return p ? <img src={p.data} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 10, border: "1px solid #2a2a3e" }} /> : null; })()}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Measurements ──────────────────────────────────────────────────

function MeasurementsSection({ measurements, onChange, allData }) {
  const measureData = {};
  MEASURE_FIELDS.forEach(f => {
    const pts = Object.entries(allData).filter(([, d]) => d.measurements?.[f.key]).map(([k, d]) => ({ date: formatDate(k, true), value: parseRange(d.measurements[f.key]) })).sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length > 0) measureData[f.key] = pts;
  });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        {MEASURE_FIELDS.map(f => (
          <div key={f.key}>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{f.icon} {f.label} (cm)</div>
            <input type="text" value={measurements[f.key] || ""} onChange={e => onChange({ ...measurements, [f.key]: e.target.value })}
              placeholder="—" style={{ ...inp }} />
          </div>
        ))}
      </div>
      {Object.entries(measureData).map(([key, pts]) => {
        if (pts.length < 2) return null;
        const field = MEASURE_FIELDS.find(f => f.key === key);
        const first = pts[0].value; const last = pts[pts.length - 1].value;
        const diff = (last - first).toFixed(1);
        return (
          <div key={key} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", marginBottom: 4 }}>
              <span>{field?.icon} {field?.label}</span>
              <span style={{ color: parseRange(diff) < 0 ? "#4ade80" : parseRange(diff) > 0 ? "#f87171" : "#888" }}>{diff > 0 ? "+" : ""}{diff}cm</span>
            </div>
            <ResponsiveContainer width="100%" height={60}>
              <LineChart data={pts} margin={{ top: 2, right: 4, left: -30, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#444" }} />
                <YAxis tick={{ fontSize: 9, fill: "#444" }} domain={["auto", "auto"]} />
                <Line type="monotone" dataKey="value" stroke="#7c3aed" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────

function SettingsModal({ settings, onSave, onClose }) {
  const [local, setLocal] = useState(settings);

  const [macroMsg, setMacroMsg] = useState("");

  const calcMacros = () => {
    const bw = parseRange(local.bodyWeight);
    const tdee = parseRange(local.tdee);
    if (!tdee) { setMacroMsg("Primero ingresá tu TDEE."); return; }
    if (!bw) { setMacroMsg("Ingresá tu peso para calcular proteína."); return; }
    const prot = Math.round(bw * 1.8);
    const fatCal = Math.round(tdee * 0.25);
    const fatG = Math.round(fatCal / 9);
    const protCal = prot * 4;
    const carbsCal = tdee - protCal - fatCal;
    const carbsG = Math.max(Math.round(carbsCal / 4), 0);
    setLocal(s => ({ ...s, proteinGoal: String(prot), carbsGoal: String(carbsG), fatGoal: String(fatG) }));
    setMacroMsg(`✓ Calculado: ${prot}g prot · ${carbsG}g carbos · ${fatG}g grasas`);
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "#13131f", border: "1px solid #2a2a3e", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#e2e8f0", marginBottom: 4 }}>⚙️ Tu perfil</div>
        <div style={{ fontSize: 12, color: "#555", marginBottom: 20 }}>Para déficit, macros y proyecciones</div>
        <Lbl>Peso actual (kg)</Lbl>
        <input type="text" value={local.bodyWeight} onChange={e => setLocal(s => ({ ...s, bodyWeight: e.target.value }))} placeholder="Ej: 78" style={{ ...inp, marginBottom: 14 }} />
        <Lbl>TDEE (kcal de mantenimiento)</Lbl>
        <input type="text" value={local.tdee} onChange={e => setLocal(s => ({ ...s, tdee: e.target.value }))} placeholder="Ej: 2500" style={{ ...inp, marginBottom: 14 }} />

        <div style={{ background: "#0d0d1a", border: "1px solid #7c3aed33", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#7c3aed", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 }}>Metas de macros diarias</div>
          <button onClick={calcMacros} style={{ width: "100%", padding: "8px 0", borderRadius: 8, border: "none", background: "#7c3aed22", color: "#7c3aed", cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 12 }}>
            ✨ Calcular automáticamente para bajar grasa
          </button>
          {macroMsg && <div style={{ fontSize: 11, color: macroMsg.startsWith("✓") ? "#4ade80" : "#f87171", marginBottom: 8 }}>{macroMsg}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, color: "#4ade80", marginBottom: 4 }}>🟢 Proteína (g)</div>
              <input type="text" value={local.proteinGoal} onChange={e => setLocal(s => ({ ...s, proteinGoal: e.target.value }))} placeholder="140" style={{ ...inp, fontSize: 12 }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#60a5fa", marginBottom: 4 }}>🔵 Carbos (g)</div>
              <input type="text" value={local.carbsGoal || ""} onChange={e => setLocal(s => ({ ...s, carbsGoal: e.target.value }))} placeholder="180" style={{ ...inp, fontSize: 12 }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#fb923c", marginBottom: 4 }}>🟠 Grasas (g)</div>
              <input type="text" value={local.fatGoal || ""} onChange={e => setLocal(s => ({ ...s, fatGoal: e.target.value }))} placeholder="65" style={{ ...inp, fontSize: 12 }} />
            </div>
          </div>
          {local.proteinGoal && local.carbsGoal && local.fatGoal && (
            <div style={{ marginTop: 8, fontSize: 11 }}>
              {(() => {
                const total = Math.round(parseRange(local.proteinGoal||0)*4 + parseRange(local.carbsGoal||0)*4 + parseRange(local.fatGoal||0)*9);
                const diff = local.tdee ? Math.abs(total - parseRange(local.tdee)) : null;
                return <span style={{ color: diff !== null && diff <= 50 ? "#4ade80" : "#555" }}>
                  Total: {total} kcal {diff !== null && diff <= 50 ? "✓ coincide con TDEE" : local.tdee ? `· ${diff} kcal de diferencia con TDEE` : ""}
                </span>;
              })()}
            </div>
          )}
        </div>

        <Lbl>Peso meta (kg)</Lbl>
        <input type="text" value={local.goalWeight} onChange={e => setLocal(s => ({ ...s, goalWeight: e.target.value }))} placeholder="Ej: 72" style={{ ...inp, marginBottom: 14 }} />
        <Lbl>Plazo meta (semanas)</Lbl>
        <input type="text" value={local.goalWeeks} onChange={e => setLocal(s => ({ ...s, goalWeeks: e.target.value }))} placeholder="Ej: 16" style={{ ...inp, marginBottom: 14 }} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          <div>
            <Lbl>Meta de pasos diaria</Lbl>
            <input type="text" value={local.stepsGoal || "10000"} onChange={e => setLocal(s => ({ ...s, stepsGoal: e.target.value }))} placeholder="10000" style={inp} />
          </div>
          <div>
            <Lbl>Meta de agua (vasos)</Lbl>
            <input type="text" value={local.waterGoal || "8"} onChange={e => setLocal(s => ({ ...s, waterGoal: e.target.value }))} placeholder="8" style={inp} />
          </div>
        </div>
        <Lbl>Plan semanal</Lbl>
        <div style={{ fontSize: 11, color: "#444", marginBottom: 8 }}>Podés seleccionar múltiples por día (ej: Upper + Abdomen)</div>
        {DAY_NAMES.map((day, dow) => {
          const current = (local.weekPlan || {})[dow] || "";
          const selected = current ? current.split("+").map(s => s.trim()).filter(Boolean) : [];
          const toggle = (type) => {
            const next = selected.includes(type) ? selected.filter(t => t !== type) : [...selected, type];
            setLocal(s => ({ ...s, weekPlan: { ...(s.weekPlan || {}), [dow]: next.join(" + ") } }));
          };
          return (
            <div key={dow} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: selected.length > 0 ? "#e2e8f0" : "#666", fontWeight: selected.length > 0 ? 600 : 400, marginBottom: 4 }}>
                {day} {selected.length > 0 ? `— ${selected.join(" + ")}` : "— Descanso"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {GYM_TYPES.map(t => (
                  <button key={t} onClick={() => toggle(t)}
                    style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, border: "none", cursor: "pointer", background: selected.includes(t) ? "#7c3aed" : "#1a1a2e", color: selected.includes(t) ? "#fff" : "#555" }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #2a2a3e", background: "none", color: "#888", cursor: "pointer" }}>Cancelar</button>
          <button onClick={() => { onSave(local); onClose(); }} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Guardar</button>
        </div>
      </div>
    </div>
  );
}

// ── Summary modal ─────────────────────────────────────────────────

function SummaryModal({ allData, settings, onClose }) {
  const [text, setText] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { getWeeklySummary(allData, settings).then(t => { setText(t); setLoading(false); }).catch(() => { setText("No se pudo generar el resumen."); setLoading(false); }); }, []);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: "#13131f", border: "1px solid #2a2a3e", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: "24px 20px 36px", width: "100%", maxWidth: 520, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#e2e8f0" }}>📊 Resumen semanal IA</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        {loading ? <div style={{ textAlign: "center", padding: "40px 0", color: "#555" }}><div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>Analizando…</div>
          : <div style={{ fontSize: 14, color: "#c4c4d4", lineHeight: 1.75, whiteSpace: "pre-wrap" }}>{text}</div>}
      </div>
    </div>
  );
}

// ── History view ──────────────────────────────────────────────────

function HistoryView({ allData, settings }) {
  const [showSummary, setShowSummary] = useState(false);
  const [histTab, setHistTab] = useState("dias");
  const keys = Object.keys(allData).sort();
  const last14 = [...keys].reverse().slice(0, 14);
  const weightData = keys.filter(k => allData[k]?.weight).map(k => ({ date: formatDate(k, true), weight: parseRange(allData[k].weight) }));
  const calData = keys.filter(k => (allData[k]?.meals || []).some(m => m.nutrition)).map(k => { const cal = (allData[k].meals || []).filter(m => m.nutrition).reduce((a, m) => a + (m.nutrition.calorias || 0), 0); return { date: formatDate(k, true), cal: Math.round(cal) }; });

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", paddingBottom: 80 }}>
      <button onClick={() => setShowSummary(true)} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "1px solid #7c3aed44", background: "#7c3aed11", color: "#7c3aed", cursor: "pointer", fontWeight: 700, fontSize: 14, marginBottom: 12 }}>📊 Resumen semanal con IA</button>
      <div style={{ display: "flex", gap: 4, background: "#13131f", borderRadius: 10, padding: 4, marginBottom: 12 }}>
        {[["dias", "Días"], ["medidas", "Medidas"], ["fotos", "Comparar fotos"]].map(([id, label]) => (
          <button key={id} onClick={() => setHistTab(id)} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer", background: histTab === id ? "#7c3aed" : "none", color: histTab === id ? "#fff" : "#555", fontWeight: histTab === id ? 700 : 400, fontSize: 11 }}>{label}</button>
        ))}
      </div>

      {histTab === "dias" && (
        <>
          {weightData.length > 1 && (
            <Sec title="⚖️ Peso">
              <ResponsiveContainer width="100%" height={130}>
                <LineChart data={weightData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#555" }} /><YAxis tick={{ fontSize: 10, fill: "#555" }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8, fontSize: 12 }} />
                  <Line type="monotone" dataKey="weight" stroke="#7c3aed" strokeWidth={2} dot={{ r: 3, fill: "#7c3aed" }} />
                </LineChart>
              </ResponsiveContainer>
            </Sec>
          )}
          {calData.length > 1 && (
            <Sec title="🔥 Calorías">
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={calData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#555" }} /><YAxis tick={{ fontSize: 10, fill: "#555" }} />
                  <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8, fontSize: 12 }} />
                  {settings.tdee && <ReferenceLine y={parseRange(settings.tdee)} stroke="#f8712244" strokeDasharray="4 4" />}
                  <Line type="monotone" dataKey="cal" stroke="#facc15" strokeWidth={2} dot={{ r: 3, fill: "#facc15" }} />
                </LineChart>
              </ResponsiveContainer>
            </Sec>
          )}
          <Sec title="📋 Días recientes">
            {last14.length === 0 ? <div style={{ color: "#444", fontSize: 14, textAlign: "center", padding: "20px 0" }}>Sin días registrados.</div>
              : last14.map(key => {
                const d = allData[key]; const t = getDayTotals(d); const score = getDayScore(d);
                const col = score === 3 ? "#4ade80" : score === 2 ? "#facc15" : score === 1 ? "#fb923c" : "#2a2a3e";
                return (
                  <div key={key} style={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 10, padding: "10px 14px", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ minWidth: 76 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{formatDate(key)}</div>
                        {d.gymType && <div style={{ fontSize: 11, color: "#7c3aed" }}>{d.gymType}</div>}
                      </div>
                      <div style={{ flex: 1, display: "flex", gap: 5 }}>
                        {[{ ok: (parseRange(d.steps) || 0) >= 10000, i: "👟" }, { ok: d.gym, i: "🏋️" }, { ok: (d.meals || []).length >= 3, i: "🍽️" }, { ok: (d.waterGlasses || 0) >= 8, i: "💧" }].map((c, i) => <span key={i} style={{ fontSize: 15, opacity: c.ok ? 1 : 0.15 }}>{c.i}</span>)}
                      </div>
                      <div style={{ fontWeight: 800, color: col, fontSize: 16 }}>{score}/3</div>
                    </div>
                    {(t.cal > 0 || d.weight) && (
                      <div style={{ display: "flex", gap: 10, marginTop: 5, fontSize: 11, color: "#555", flexWrap: "wrap" }}>
                        {t.cal > 0 && <span>🔥 {Math.round(t.cal)} kcal</span>}
                        {t.prot > 0 && <span>🥩 {Math.round(t.prot)}g</span>}
                        {d.weight && <span>⚖️ {d.weight}kg</span>}
                        {(d.exercises || []).length > 0 && <span>💪 {d.exercises.length} ej.</span>}
                      </div>
                    )}
                  </div>
                );
              })}
          </Sec>
        </>
      )}
      {histTab === "medidas" && (
        <Sec title="📏 Medidas corporales">
          <MeasurementsSection measurements={allData[todayKey()]?.measurements || {}} onChange={() => {}} allData={allData} />
        </Sec>
      )}
      {histTab === "fotos" && (
        <Sec title="📸 Comparar fotos">
          <PhotoCompare allData={allData} />
        </Sec>
      )}
      {showSummary && <SummaryModal allData={allData} settings={settings} onClose={() => setShowSummary(false)} />}
    </div>
  );
}

// ── Projections view ──────────────────────────────────────────────

function ProjectionsView({ allData, settings }) {
  const proj = computeProjections(allData, settings);
  const keys = Object.keys(allData).sort().reverse();
  if (!proj) return <div style={{ textAlign: "center", padding: "40px 20px", color: "#444" }}><div style={{ fontSize: 28, marginBottom: 8 }}>📈</div><div>Registrá algunos días y completá tu perfil en ⚙️ para ver proyecciones.</div></div>;

  const compRate = Math.round(proj.complianceRate * 100);
  const compColor = compRate >= 80 ? "#4ade80" : compRate >= 50 ? "#facc15" : "#f87171";
  const weekScores = [];
  for (let i = 0; i < Math.min(keys.length, 28); i += 7) {
    const week = keys.slice(i, i + 7);
    const comp = week.filter(k => getDayScore(allData[k]) >= 2).length;
    weekScores.unshift({ week: i === 0 ? "Esta" : `−${Math.floor(i / 7)}s`, comp, total: week.length, pct: Math.round((comp / week.length) * 100) });
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", paddingBottom: 80 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {[
          { v: `${compRate}%`, sub: `${keys.length} días`, label: "Cumplimiento", color: compColor },
          proj.avgDeficit > 0 && { v: `−${proj.avgDeficit}`, sub: "kcal/día", label: "Déficit prom.", color: "#4ade80" },
          proj.weeklyLoss > 0 && { v: `−${proj.weeklyLoss.toFixed(2)}`, sub: "kg/sem", label: "Proyectado", color: "#7c3aed" },
        ].filter(Boolean).map((c, i) => (
          <div key={i} style={{ flex: 1, background: "#13131f", border: "1px solid #1e1e2e", borderRadius: 12, padding: "12px 8px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: c.color }}>{c.v}</div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 1 }}>{c.sub}</div>
            <div style={{ fontSize: 10, color: "#444" }}>{c.label}</div>
          </div>
        ))}
      </div>

      {proj.weeksToGoal && settings.goalWeight && (
        <div style={{ background: "#13131f", border: "1px solid #7c3aed44", borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#7c3aed", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>🎯 Meta: {settings.goalWeight}kg</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 28, fontWeight: 900, color: "#e2e8f0" }}>{proj.weeksToGoal}</span>
            <span style={{ fontSize: 14, color: "#888" }}>semanas</span>
            <span style={{ fontSize: 12, color: "#555" }}>al ritmo actual</span>
          </div>
          {proj.kgToGoal && <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>Faltan {proj.kgToGoal.toFixed(1)}kg</div>}
          {settings.goalWeeks && proj.weeksToGoal > parseRange(settings.goalWeeks) && (
            <div style={{ marginTop: 8, padding: "8px 10px", background: "#fb923c11", borderRadius: 8, fontSize: 12, color: "#fb923c" }}>⚠️ Al ritmo actual llegás en {proj.weeksToGoal}s, no en {settings.goalWeeks}s. Necesitás +{Math.round((proj.kgToGoal / parseRange(settings.goalWeeks) * 7700 / 7) - proj.avgDeficit)} kcal de déficit extra/día.</div>
          )}
          {settings.goalWeeks && proj.weeksToGoal <= parseRange(settings.goalWeeks) && (
            <div style={{ marginTop: 8, padding: "8px 10px", background: "#4ade8011", borderRadius: 8, fontSize: 12, color: "#4ade80" }}>✅ Vas bien, llegás antes de las {settings.goalWeeks} semanas.</div>
          )}
        </div>
      )}

      {settings.bodyWeight && proj.weeklyLoss > 0 && (
        <Sec title="⚖️ Proyección de peso">
          <div style={{ fontSize: 11, color: "#555", marginBottom: 8 }}>Déficit promedio: {proj.avgDeficit} kcal/día</div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={proj.weightProjection.slice(0, 13)} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis dataKey="week" tick={{ fontSize: 10, fill: "#555" }} /><YAxis tick={{ fontSize: 10, fill: "#555" }} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8, fontSize: 12 }} formatter={(v) => [`${v}kg`]} />
              {settings.goalWeight && <ReferenceLine y={parseRange(settings.goalWeight)} stroke="#7c3aed44" strokeDasharray="4 4" />}
              <Line type="monotone" dataKey="weight" stroke="#4ade80" strokeWidth={2} dot={{ r: 3, fill: "#4ade80" }} strokeDasharray="6 3" />
            </LineChart>
          </ResponsiveContainer>
        </Sec>
      )}

      {weekScores.length > 0 && (
        <Sec title="📊 Cumplimiento semanal">
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 80, marginBottom: 8 }}>
            {weekScores.map((w, i) => { const col = w.pct >= 80 ? "#4ade80" : w.pct >= 50 ? "#facc15" : "#f87171"; return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 10, color: col, fontWeight: 700 }}>{w.pct}%</div>
                <div style={{ width: "100%", height: `${Math.max(w.pct, 5)}%`, background: col, borderRadius: "4px 4px 0 0", minHeight: 4 }} />
                <div style={{ fontSize: 9, color: "#444" }}>{w.week}</div>
              </div>
            ); })}
          </div>
          <div style={{ fontSize: 11, color: "#555" }}>{compRate >= 80 ? "🔥 Excelente consistencia." : compRate >= 50 ? "⚡ Buen ritmo, hay margen para mejorar." : "💡 La consistencia es lo más importante. Apuntá a 4/7 días."}</div>
        </Sec>
      )}

      <Sec title="🔮 Próximas 4 semanas">
        {[
          { label: "Días de gym esperados", value: `~${Math.round(proj.complianceRate * 5 * 4)} de 20`, icon: "🏋️" },
          { label: "Días de 10k pasos", value: `~${Math.round(proj.complianceRate * 7 * 4)} de 28`, icon: "👟" },
          { label: "Peso en 4 semanas", value: proj.weeklyLoss > 0 && settings.bodyWeight ? `~${(parseRange(settings.bodyWeight) - proj.weeklyLoss * 4).toFixed(1)}kg` : "—", icon: "⚖️" },
          { label: "Déficit acumulado", value: proj.avgDeficit > 0 ? `~${Math.round(proj.avgDeficit * 28)} kcal` : "—", icon: "🔥" },
        ].map((item, i, arr) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid #1a1a2e" : "none" }}>
            <span style={{ fontSize: 13, color: "#888" }}>{item.icon} {item.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{item.value}</span>
          </div>
        ))}
      </Sec>
    </div>
  );
}

// ── Day view ──────────────────────────────────────────────────────

function DayView({ date, data, onChange, settings, allData, routines, showDashboard = false }) {
  const [showMealModal, setShowMealModal] = useState(false);
  const [routineAnalysis, setRoutineAnalysis] = useState(null);
  const [analyzingRoutine, setAnalyzingRoutine] = useState(false);
  const [preciseCalories, setPreciseCalories] = useState(null);
  const [calcingPrecise, setCalcingPrecise] = useState(false);

  const calcPrecise = async () => {
    if (!(data.exercises || []).length) return;
    setCalcingPrecise(true);
    try {
      const result = await calcPreciseCalories(data.exercises, routineAnalysis?.duration || 60, settings.bodyWeight);
      setPreciseCalories(result);
    } catch {}
    setCalcingPrecise(false);
  };

  const dow = todayDow();
  const plannedType = (settings.weekPlan || {})[dow] || "";

  const addMeal = async ({ name, mealTime, aclaraciones = "", photoBase64 = null }) => {
    const id = Date.now();
    const newMeal = { id, name, mealTime, loading: true, nutrition: null, error: false, errorMsg: "" };
    const mealsWithNew = [...(data.meals || []), newMeal];
    onChange({ ...data, meals: mealsWithNew });
    try {
      const nutrition = await analyzeMeal(name, aclaraciones, photoBase64);
      const updated = mealsWithNew.map(m => m.id === id ? { ...m, loading: false, nutrition } : m);
      onChange({ ...data, meals: updated });
    } catch(e) {
      const errorMsg = e?.message || "Error desconocido";
      const updated = mealsWithNew.map(m => m.id === id ? { ...m, loading: false, error: true, errorMsg } : m);
      onChange({ ...data, meals: updated });
    }
  };

  const updateMeal = (id, updated) => onChange({ ...data, meals: (data.meals || []).map(m => m.id === id ? { ...m, ...updated } : m) });

  const selectRoutine = async (routineId) => {
    const r = routines.find(x => x.id === parseInt(routineId) || x.id === routineId);
    onChange({ ...data, gymRoutineId: routineId, gymType: r?.type || data.gymType, exercises: r ? (r.exercises || []).map(e => ({ id: Date.now() + Math.random(), name: e.name, sets: e.sets || "", reps: e.reps || "", weightRange: e.weight || "", notes: e.notes || "", targetSets: e.sets, targetReps: e.reps, targetWeight: e.weight })) : data.exercises });
    if (r) {
      setAnalyzingRoutine(true);
      try { setRoutineAnalysis(await analyzeRoutine(r, settings.bodyWeight)); } catch {}
      setAnalyzingRoutine(false);
    }
  };

  const burnedCal = preciseCalories?.calorias_quemadas || routineAnalysis?.calorias_quemadas || 0;

  return (
    <div style={{ paddingBottom: 100 }}>
      {showMealModal && <AddMealModal onAdd={addMeal} onClose={() => setShowMealModal(false)} recentMeals={
        [...new Set(Object.values(allData).flatMap(d => (d.meals || []).map(m => m.name)).filter(Boolean))].slice(0, 8)
      } />}

      {showDashboard && <QuickDashboard data={data} settings={settings} allData={allData} />}

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "#7c3aed", letterSpacing: 2, marginBottom: 2 }}>{date === todayKey() ? "HOY" : "EDITANDO"}</div>
        <div style={{ fontSize: 28, fontWeight: 900, color: "#fff", letterSpacing: -1 }}>{formatDate(date)}</div>
        {plannedType && (
          <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, background: "#7c3aed18", border: "1px solid #7c3aed33", borderRadius: 99, padding: "3px 10px" }}>
            <span style={{ fontSize: 11, color: "#a78bfa" }}>Toca hoy · {plannedType}</span>
          </div>
        )}
      </div>

      {/* Pasos */}
      <Sec title="👟 Pasos">
        <input type="text" value={data.steps} onChange={e => onChange({ ...data, steps: e.target.value })} placeholder={`Meta: ${settings.stepsGoal || 10000} pasos`} style={inp} />
        {data.steps && <StepsBar steps={data.steps} goal={settings.stepsGoal || 10000} bodyWeight={parseRange(settings.bodyWeight) || 70} />}
      </Sec>

      {/* Entrenamiento */}
      <Sec title="🏋️ Entrenamiento">
        <Toggle label="Entrené hoy" active={data.gym} onToggle={() => onChange({ ...data, gym: !data.gym, gymType: "", exercises: [], gymRoutineId: null })} />
        {data.gym && (
          <div style={{ marginTop: 14 }}>
            {/* Tipo */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {GYM_TYPES.map(t => (
                <button key={t} onClick={() => onChange({ ...data, gymType: t })}
                  style={{ padding: "5px 14px", borderRadius: 99, fontSize: 12, cursor: "pointer", border: "none", background: data.gymType === t ? "#7c3aed" : "#1a1a2e", color: data.gymType === t ? "#fff" : "#666", fontWeight: data.gymType === t ? 700 : 400, transition: "all 0.15s" }}>
                  {t}
                </button>
              ))}
            </div>

            {/* Rutina */}
            {routines.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <select value={data.gymRoutineId || ""} onChange={e => selectRoutine(e.target.value)} style={{ ...inp }}>
                  <option value="">Sin rutina predefinida</option>
                  {routines.map(r => <option key={r.id} value={r.id}>{r.name} — {r.type}</option>)}
                </select>
                {analyzingRoutine && <div style={{ fontSize: 12, color: "#666", marginTop: 8, textAlign: "center" }}>Analizando rutina…</div>}
                {routineAnalysis && !analyzingRoutine && (
                  <div style={{ marginTop: 10, background: "#1a1a2e", borderRadius: 10, padding: "12px 14px", borderLeft: "3px solid #7c3aed" }}>
                    <div style={{ fontSize: 12, color: "#c4c4d4", marginBottom: 8 }}>{routineAnalysis.descripcion}</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: "#facc15" }}>🔥 {routineAnalysis.calorias_quemadas} kcal</span>
                      <span style={{ color: "#4ade80" }}>{routineAnalysis.proteina_recomendada_g}g prot post</span>
                      <span style={{ color: "#60a5fa" }}>{routineAnalysis.carbos_recomendados_g}g carbos post</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#7c3aed" }}>💡 {routineAnalysis.consejo_post}</div>
                  </div>
                )}
              </div>
            )}

            {/* Ejercicios de la rutina (readonly summary) + calc preciso */}
            {(data.exercises || []).length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "#555", marginBottom: 8 }}>Ejercicios de hoy</div>
                {data.exercises.map(ex => (
                  <div key={ex.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 10px", background: "#1a1a2e", borderRadius: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: "#e2e8f0" }}>{ex.name}</span>
                    <span style={{ fontSize: 12, color: "#555" }}>{[ex.sets && `${ex.sets}s`, ex.reps && `${ex.reps}r`, ex.weightRange && `${ex.weightRange}kg`].filter(Boolean).join(" × ") || "—"}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8 }}>
                  {!preciseCalories && !calcingPrecise && (
                    <button onClick={calcPrecise} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: "1px solid #facc1533", background: "#facc1509", color: "#facc15", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                      🔥 Calcular calorías reales quemadas
                    </button>
                  )}
                  {calcingPrecise && <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: "8px 0" }}>Calculando…</div>}
                  {preciseCalories && !calcingPrecise && (
                    <div style={{ background: "#1a1a2e", borderRadius: 10, padding: "10px 14px", borderLeft: "3px solid #facc15" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#facc15" }}>🔥 {preciseCalories.calorias_quemadas} kcal</span>
                        <span style={{ fontSize: 11, color: "#666" }}>{preciseCalories.intensidad}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{preciseCalories.detalle}</div>
                      <button onClick={() => setPreciseCalories(null)} style={{ marginTop: 4, background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 10 }}>Recalcular</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Sec>

      <Sec title="🍽️ Comidas">
        <DailyNutrition meals={data.meals || []} settings={settings} burnedCal={burnedCal} />
        {(data.meals || []).map(meal => (
          <MealCard key={meal.id} meal={meal}
            onDelete={() => onChange({ ...data, meals: data.meals.filter(m => m.id !== meal.id) })}
            onUpdate={updated => updateMeal(meal.id, updated)} />
        ))}
        <button onClick={() => setShowMealModal(true)} style={{ width: "100%", padding: "9px 0", borderRadius: 10, border: "1px dashed #2a2a3e", background: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13, marginTop: 4 }}>
          + Registrar comida
        </button>
        <MealRecommendations meals={data.meals || []} settings={settings} burnedCal={burnedCal} />
      </Sec>

      <Sec title="💧 Hidratación">
        {(() => {
          const waterGoal = parseRange(settings.waterGoal) || 8;
          const current = data.waterGlasses || 0;
          const pct = Math.min(current / waterGoal, 1);
          const color = pct >= 1 ? "#4ade80" : pct >= 0.5 ? "#60a5fa" : "#555";
          return (
            <>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                {Array.from({ length: Math.min(waterGoal, 16) }, (_, i) => (
                  <button key={i} onClick={() => onChange({ ...data, waterGlasses: i + 1 === current ? i : i + 1 })}
                    style={{ fontSize: 20, background: "none", border: "none", cursor: "pointer", opacity: current > i ? 1 : 0.2, padding: 2 }}>💧</button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color, marginBottom: 4 }}>
                <span>{current} / {waterGoal} vasos</span>
                {current >= waterGoal && <span>✓ meta cumplida</span>}
                {current < waterGoal && <span>faltan {waterGoal - current}</span>}
              </div>
              <div style={{ height: 4, background: "#1e1e2e", borderRadius: 99 }}>
                <div style={{ height: 4, width: `${pct * 100}%`, background: color, borderRadius: 99, transition: "width 0.4s" }} />
              </div>
            </>
          );
        })()}
      </Sec>

      <Sec title="📏 Medidas corporales">
        <MeasurementsSection measurements={data.measurements || {}} onChange={m => onChange({ ...data, measurements: m })} allData={allData} />
      </Sec>

      <Sec title="📸 Foto de progreso">
        <PhotoSection photos={data.photos || []} onChange={photos => onChange({ ...data, photos })} />
      </Sec>

      <Sec title="⚖️ Peso">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="text" value={data.weight} onChange={e => onChange({ ...data, weight: e.target.value })} placeholder="—" style={{ ...inp, width: 90 }} />
          <span style={{ color: "#444", fontSize: 12 }}>kg · siempre a la misma hora</span>
        </div>
      </Sec>

      <Sec title="📝 Notas">
        <textarea value={data.notes} onChange={e => onChange({ ...data, notes: e.target.value })} placeholder="Cómo dormiste, energía, dolor muscular…" style={{ ...inp, minHeight: 64, resize: "vertical" }} />
      </Sec>
    </div>
  );
}

// ── Calendar view ─────────────────────────────────────────────────

function CalendarView({ allData, settings, onSelectDate }) {
  const [viewDate, setViewDate] = useState(new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayKey();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const keyFor = (d) => `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const changeMonth = (delta) => setViewDate(new Date(year, month + delta, 1));

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", paddingBottom: 80 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button onClick={() => changeMonth(-1)} style={{ background: "#13131f", border: "1px solid #1e1e2e", borderRadius: 8, width: 34, height: 34, color: "#e2e8f0", cursor: "pointer", fontSize: 16 }}>‹</button>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#e2e8f0" }}>{monthNames[month]} {year}</div>
        <button onClick={() => changeMonth(1)} style={{ background: "#13131f", border: "1px solid #1e1e2e", borderRadius: 8, width: 34, height: 34, color: "#e2e8f0", cursor: "pointer", fontSize: 16 }}>›</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 6 }}>
        {DAY_NAMES.map(d => <div key={d} style={{ textAlign: "center", fontSize: 10, color: "#444", fontWeight: 700 }}>{d}</div>)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const key = keyFor(d);
          const dayData = allData[key];
          const score = getDayScore(dayData);
          const isToday = key === today;
          const isFuture = key > today;
          const dow = new Date(year, month, d).getDay();
          const planned = (settings.weekPlan || {})[dow] || "";
          const hasData = dayData && ((dayData.meals || []).length > 0 || dayData.gym || dayData.steps);
          const col = !hasData ? "transparent" : score === 3 ? "#4ade80" : score === 2 ? "#facc15" : score === 1 ? "#fb923c" : "#f87171";

          return (
            <button key={i} onClick={() => onSelectDate(key)}
              style={{
                aspectRatio: "1", borderRadius: 10, border: isToday ? "2px solid #7c3aed" : "1px solid #1e1e2e",
                background: hasData ? `${col}18` : "#13131f", cursor: "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", padding: 2, position: "relative"
              }}>
              <span style={{ fontSize: 12, color: isToday ? "#a78bfa" : isFuture ? "#444" : "#888", fontWeight: isToday ? 800 : 400 }}>{d}</span>
              {hasData && <div style={{ width: 5, height: 5, borderRadius: "50%", background: col, marginTop: 2 }} />}
              {!hasData && isFuture && planned && <div style={{ fontSize: 7, color: "#555", marginTop: 1 }}>{planned.slice(0, 3)}</div>}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, fontSize: 11, color: "#555", flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#4ade80", marginRight: 4 }} />3/3 cumplido</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#facc15", marginRight: 4 }} />2/3</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#f87171", marginRight: 4 }} />0-1/3</span>
      </div>

      <div style={{ fontSize: 11, color: "#444", marginTop: 8 }}>Tocá cualquier día para ver o cargar su registro — incluso días futuros, para planificar.</div>
    </div>
  );
}



// ── Quick Dashboard ───────────────────────────────────────────────

function QuickDashboard({ data, settings, allData }) {
  const today = todayKey();
  const t = getDayTotals(data);
  const protGoal = parseRange(settings.proteinGoal) || 0;
  const carbsGoal = parseRange(settings.carbsGoal) || 0;
  const fatGoal = parseRange(settings.fatGoal) || 0;
  const tdee = parseRange(settings.tdee) || 0;
  const stepsGoal = parseRange(settings.stepsGoal) || 10000;
  const waterGoal = parseRange(settings.waterGoal) || 8;
  const steps = parseRange(data.steps) || 0;
  const water = data.waterGlasses || 0;

  const items = [
    { label: "Calorías", value: Math.round(t.cal), goal: tdee, unit: "kcal", color: "#facc15", invert: true },
    { label: "Proteína", value: Math.round(t.prot), goal: protGoal, unit: "g", color: "#4ade80" },
    { label: "Carbos", value: Math.round(t.carbs), goal: carbsGoal, unit: "g", color: "#60a5fa" },
    { label: "Grasas", value: Math.round(t.fat), goal: fatGoal, unit: "g", color: "#fb923c" },
    { label: "Pasos", value: steps, goal: stepsGoal, unit: "", color: "#a78bfa" },
    { label: "Agua", value: water, goal: waterGoal, unit: " vas.", color: "#38bdf8" },
  ].filter(item => item.goal > 0 || item.value > 0);

  if (items.every(i => i.value === 0)) return <></>;

  return (
    <div style={{ background: "#111120", borderRadius: 16, padding: "14px 16px", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 10 }}>Resumen de hoy</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {items.slice(0, 6).map((item, i) => {
          const pct = item.goal > 0 ? Math.min(item.value / item.goal, 1) : 0;
          const done = item.goal > 0 && item.value >= item.goal;
          const over = item.goal > 0 && item.value > item.goal && !item.invert;
          return (
            <div key={i} style={{ background: "#0a0a14", borderRadius: 10, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: done ? item.color : over ? "#f87171" : "#e2e8f0" }}>
                {item.value.toLocaleString()}<span style={{ fontSize: 10, color: "#555", fontWeight: 400 }}>{item.unit}</span>
              </div>
              {item.goal > 0 && (
                <>
                  <div style={{ height: 3, background: "#1e1e2e", borderRadius: 99, marginTop: 4 }}>
                    <div style={{ height: 3, width: `${pct * 100}%`, background: done ? item.color : "#2a2a3e", borderRadius: 99, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>
                    {done ? "✓ meta" : `${item.goal > 0 ? Math.round(item.goal - item.value) : ""}${item.unit} restante`}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const [allData, setAllData] = useState({});
  const [settings, setSettings] = useState(defaultSettings());
  const [routines, setRoutines] = useState([]);
  const [tab, setTab] = useState("hoy");
  const [showSettings, setShowSettings] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const importRef = useRef(null);
  const today = todayKey();

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY); if (s) setAllData(JSON.parse(s));
      const cfg = localStorage.getItem(SETTINGS_KEY); if (cfg) setSettings(JSON.parse(cfg));
      const rt = localStorage.getItem(ROUTINES_KEY); if (rt) setRoutines(JSON.parse(rt));
    } catch {}
  }, []);

  const saveSettings = s => { setSettings(s); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };
  const saveRoutines = r => { setRoutines(r); try { localStorage.setItem(ROUTINES_KEY, JSON.stringify(r)); } catch {} };

  const updateDayFor = useCallback((dateKey, dayOrUpdater) => {
    setAllData(prev => {
      const current = prev[dateKey] || defaultDay();
      const next = typeof dayOrUpdater === "function" ? dayOrUpdater(current) : dayOrUpdater;
      const updated = { ...prev, [dateKey]: next };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const updateDay = useCallback(dayOrUpdater => updateDayFor(today, dayOrUpdater), [today, updateDayFor]);
  const todayData = allData[today] || defaultDay();

  // Export
  const handleExport = () => {
    const payload = { allData, settings, routines, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(payload, null, 2);
    const dataUri = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    const a = document.createElement("a");
    a.href = dataUri;
    a.download = `definicion-backup-${todayKey()}.json`;
    a.click();
  };

  // Import
  const handleImport = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const payload = JSON.parse(ev.target.result);
        if (payload.allData) { setAllData(payload.allData); localStorage.setItem(STORAGE_KEY, JSON.stringify(payload.allData)); }
        if (payload.settings) { setSettings(payload.settings); localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload.settings)); }
        if (payload.routines) { setRoutines(payload.routines); localStorage.setItem(ROUTINES_KEY, JSON.stringify(payload.routines)); }
        alert("✅ Datos importados correctamente.");
      } catch { alert("❌ Archivo inválido."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Category streaks
  const stepsStreak = getCategoryStreak(allData, d => (parseRange(d?.steps) || 0) >= (parseRange(settings.stepsGoal) || 10000));
  const gymStreak = getCategoryStreak(allData, d => d?.gym);
  const protStreak = getCategoryStreak(allData, d => {
    const goal = parseRange(settings.proteinGoal) || 0;
    if (!goal) return false;
    const prot = (d?.meals || []).filter(m => m.nutrition).reduce((a, m) => a + (m.nutrition.proteinas_g || 0), 0);
    return prot >= goal;
  });

  const TABS = [["hoy", "Hoy"], ["calendario", "Cal."], ["rutinas", "Rutinas"], ["historial", "Historial"], ["proyeccion", "Proyección"]];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a14", fontFamily: "'Inter', system-ui, sans-serif", color: "#e2e8f0", padding: "24px 14px 0" }}>
      {showSettings && <SettingsModal settings={settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
      {showRoutines && <RoutinesManager routines={routines} onSave={saveRoutines} onClose={() => setShowRoutines(false)} allData={allData} />}
      <input ref={importRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />

      {/* Header */}
      <div style={{ maxWidth: 480, margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 4, color: "#7c3aed", textTransform: "uppercase", marginBottom: 1 }}>Body tracker</div>
          <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -1 }}>AGÓN</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={handleExport} title="Exportar datos" style={{ background: "#111120", border: "1px solid #1e1e2e", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 15 }}>⬇️</button>
          <button onClick={() => importRef.current?.click()} title="Importar datos" style={{ background: "#111120", border: "1px solid #1e1e2e", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 15 }}>⬆️</button>
          <button onClick={() => setShowSettings(true)} style={{ background: "#111120", border: "1px solid #1e1e2e", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 16 }}>⚙️</button>
        </div>
      </div>

      {/* Streaks */}
      {(stepsStreak > 0 || gymStreak > 0 || protStreak > 0) && (
        <div style={{ maxWidth: 480, margin: "0 auto 10px", display: "flex", gap: 6 }}>
          {[{ s: stepsStreak, icon: "👟", label: "pasos" }, { s: gymStreak, icon: "🏋️", label: "gym" }, { s: protStreak, icon: "🥩", label: "prot" }].filter(x => x.s > 0).map((x, i) => (
            <div key={i} style={{ flex: 1, background: "#111120", border: "1px solid #7c3aed22", borderRadius: 10, padding: "6px 8px", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 14 }}>{x.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#a78bfa", lineHeight: 1 }}>{x.s}🔥</div>
                <div style={{ fontSize: 9, color: "#555" }}>{x.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ maxWidth: 480, margin: "0 auto 14px", display: "flex", gap: 3, background: "#111120", borderRadius: 12, padding: 4 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setSelectedDate(null); }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", background: tab === id ? "#7c3aed" : "none", color: tab === id ? "#fff" : "#555", fontWeight: tab === id ? 700 : 400, fontSize: 12, transition: "all 0.15s" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Hoy tab */}
      {tab === "hoy" && (
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <DayView date={today} data={todayData} onChange={updateDay} settings={settings} allData={allData} routines={routines} showDashboard={true} />
        </div>
      )}
      {tab === "calendario" && !selectedDate && <CalendarView allData={allData} settings={settings} onSelectDate={setSelectedDate} />}
      {tab === "calendario" && selectedDate && (
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <button onClick={() => setSelectedDate(null)} style={{ background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 13, marginBottom: 10, padding: 0 }}>‹ Volver al calendario</button>
          <DayView date={selectedDate} data={allData[selectedDate] || defaultDay()} onChange={d => updateDayFor(selectedDate, d)} settings={settings} allData={allData} routines={routines} />
        </div>
      )}
      {tab === "rutinas" && (
        <div style={{ maxWidth: 480, margin: "0 auto", paddingBottom: 80 }}>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 14 }}>Creá y gestioná tus rutinas de entrenamiento.</div>
          {routines.length === 0 && (
            <div style={{ background: "#111120", border: "1px dashed #2a2a3e", borderRadius: 14, padding: "32px 20px", textAlign: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🏋️</div>
              <div style={{ fontSize: 14, color: "#555" }}>No tenés rutinas todavía.</div>
            </div>
          )}
          {routines.map(r => (
            <div key={r.id} style={{ background: "#111120", borderRadius: 14, padding: "14px 16px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: "#7c3aed", marginTop: 2 }}>{r.type} · {(r.exercises || []).length} ejercicios</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setShowRoutines(true)} style={{ background: "#7c3aed22", border: "none", color: "#7c3aed", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Editar</button>
                  <button onClick={() => { const nl = routines.filter(x => x.id !== r.id); saveRoutines(nl); }} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 16 }}>✕</button>
                </div>
              </div>
              {(r.exercises || []).length > 0 && (
                <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 8 }}>
                  {r.exercises.map(ex => (
                    <div key={ex.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
                      <span style={{ color: "#c4c4d4" }}>{ex.name}</span>
                      <span style={{ color: "#555" }}>
                        {ex.sets && `${ex.sets}s`}
                        {ex.perSerieReps && ex.serieReps ? ` × ${ex.serieReps.filter(Boolean).join("/")}r` : ex.reps ? ` × ${ex.reps}r` : ""}
                        {ex.perSerieWeight && ex.serieWeights ? ` · ${ex.serieWeights.filter(Boolean).join("/")}kg` : ex.weight ? ` · ${ex.weight}kg` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button onClick={() => setShowRoutines(true)} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "1px dashed #7c3aed44", background: "#7c3aed09", color: "#7c3aed", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            + Nueva rutina
          </button>
        </div>
      )}
      {tab === "historial" && <HistoryView allData={allData} settings={settings} />}
      {tab === "proyeccion" && <ProjectionsView allData={allData} settings={settings} />}
    </div>
  );
}
