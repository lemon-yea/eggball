import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Eggball - Multiplayer Soccer" },
      { name: "description", content: "Pick a team and play Eggball, a real-time multiplayer soccer game." },
      { property: "og:title", content: "Eggball" },
      { property: "og:description", content: "Real-time multiplayer soccer. Red vs Blue." },
    ],
  }),
  component: EggballPage,
});

// ---- Field constants ----
const FIELD_W = 1400;
const FIELD_H = 720;
const PAD = 70; // padded canvas area around the field so goals + out-of-bounds are visible
const CANVAS_W = FIELD_W + PAD * 2;
const CANVAS_H = FIELD_H + PAD * 2;
const PLAYER_R = 20;
const BALL_R = 14;
const GOAL_H = 220;
const GOAL_DEPTH = 46;
const POST_R = 8;
const PLAYER_SPEED = 190; // px/sec
const BALL_FRICTION = 0.965;
const BALL_MAX = 900;
const KICK_POWER = 380;
const KICK_DURATION = 0.18; // seconds
const KICK_REACH = 10; // extra px beyond touching to still land a kick
const GAME_LENGTH = 5 * 60; // seconds
const MERCY_LEAD = 5;
const CANVAS_ASPECT = CANVAS_W / CANVAS_H;

type Team = "red" | "blue" | null;

interface PlayerState {
  id: string;
  team: Exclude<Team, null>;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kickUntil: number; // timestamp ms
  lastDirX: number;
  lastDirY: number;
  name: string;
}

interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GameState {
  ball: BallState;
  scoreRed: number;
  scoreBlue: number;
  timeLeft: number; // seconds
  countdown: number; // 3..2..1..0 (0 = playing)
  ended: boolean;
  winner: Team | "draw";
  hostId: string;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function EggballPage() {
  const [team, setTeam] = useState<Team>(null);
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [score, setScore] = useState({ red: 0, blue: 0, timeLeft: GAME_LENGTH, countdown: 0, ended: false, winner: null as Team | "draw" });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const myIdRef = useRef<string>(makeId());
  const teamRef = useRef<Team>(null);
  const joinedRef = useRef(false);
  const nameRef = useRef<string>("");

  useEffect(() => {
    teamRef.current = team;
  }, [team]);
  useEffect(() => {
    joinedRef.current = joined;
  }, [joined]);

  useEffect(() => {
    const myId = myIdRef.current;
    const players = new Map<string, PlayerState>();
    const lastSeen = new Map<string, number>();
    let ball: BallState = { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 };
    let scoreRed = 0;
    let scoreBlue = 0;
    let timeLeft = GAME_LENGTH;
    let countdown = 0; // seconds remaining in countdown; 0 = playing
    let ended = false;
    let winner: Team | "draw" = null as Team | "draw";
    let hostId = myId;
    const knownIds = new Set<string>([myId]);

    const keys = new Set<string>();
    const keyDown = (e: KeyboardEvent) => {
      keys.add(e.key.toLowerCase());
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    const keyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);

    const channel = supabase.channel("eggball-room", {
      config: { broadcast: { self: false }, presence: { key: myId } },
    });

    // Handle incoming player states
    channel.on("broadcast", { event: "player" }, ({ payload }: { payload: PlayerState }) => {
      if (payload.id === myId) return;
      players.set(payload.id, payload);
      lastSeen.set(payload.id, performance.now());
      knownIds.add(payload.id);
    });
    channel.on("broadcast", { event: "leave" }, ({ payload }: { payload: { id: string } }) => {
      players.delete(payload.id);
      lastSeen.delete(payload.id);
      knownIds.delete(payload.id);
    });
    channel.on("broadcast", { event: "kick" }, ({ payload }: { payload: { bx: number; by: number; bvx: number; bvy: number } }) => {
      // Only host authoritative on ball, but any client can announce a kick they applied.
      // Only the host will process kicks; others get ball via 'state'.
      if (hostId === myId) {
        ball.x = payload.bx;
        ball.y = payload.by;
        ball.vx = payload.bvx;
        ball.vy = payload.bvy;
      }
    });
    channel.on("broadcast", { event: "state" }, ({ payload }: { payload: GameState }) => {
      if (payload.hostId === myId) return; // ignore our own would-be echoes
      ball = payload.ball;
      scoreRed = payload.scoreRed;
      scoreBlue = payload.scoreBlue;
      timeLeft = payload.timeLeft;
      countdown = payload.countdown;
      ended = payload.ended;
      winner = payload.winner;
      hostId = payload.hostId;
      setScore({ red: scoreRed, blue: scoreBlue, timeLeft, countdown, ended, winner });
    });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<{ id: string }>>;
      const ids = new Set<string>();
      Object.values(state).forEach((arr) => arr.forEach((p) => ids.add(p.id)));
      ids.add(myId);
      // Determine host = lowest id
      const sorted = Array.from(ids).sort();
      hostId = sorted[0];
      // Clean players not present
      for (const id of Array.from(players.keys())) {
        if (!ids.has(id)) players.delete(id);
      }
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ id: myId });
        setConnected(true);
      }
    });

    // ---- Game loop ----
    let lastTs = performance.now();
    let lastBroadcast = 0;
    let lastStateBroadcast = 0;
    let running = true;
    let goalCooldown = 0; // small guard after goal reset

    function resetPositions() {
      // place all players on their sides
      const allPlayers = Array.from(players.values());
      const me = getMyPlayer();
      if (me) allPlayers.push(me);
      const redTeam = allPlayers.filter((p) => p.team === "red");
      const blueTeam = allPlayers.filter((p) => p.team === "blue");
      redTeam.forEach((p, i) => {
        p.x = FIELD_W * 0.25;
        p.y = (FIELD_H / (redTeam.length + 1)) * (i + 1);
        p.vx = 0;
        p.vy = 0;
      });
      blueTeam.forEach((p, i) => {
        p.x = FIELD_W * 0.75;
        p.y = (FIELD_H / (blueTeam.length + 1)) * (i + 1);
        p.vx = 0;
        p.vy = 0;
      });
      ball = { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 };
    }

    function getMyPlayer(): PlayerState | null {
      const t = teamRef.current;
      if (!t || !joinedRef.current) return null;
      let me = players.get(myId);
      if (!me) {
        me = {
          id: myId,
          team: t,
          x: t === "red" ? FIELD_W * 0.25 : FIELD_W * 0.75,
          y: FIELD_H / 2,
          vx: 0,
          vy: 0,
          kickUntil: 0,
          lastDirX: t === "red" ? 1 : -1,
          lastDirY: 0,
          name: "",
        };
        players.set(myId, me);
      }
      if (me.team !== t) me.team = t;
      return me;
    }

    function tick() {
      if (!running) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      // Host-only: timer & countdown
      if (hostId === myId) {
        if (!ended) {
          if (countdown > 0) {
            countdown = Math.max(0, countdown - dt);
          } else {
            timeLeft = Math.max(0, timeLeft - dt);
            if (timeLeft <= 0) {
              ended = true;
              winner = scoreRed > scoreBlue ? "red" : scoreBlue > scoreRed ? "blue" : "draw";
            }
          }
        }
        if (goalCooldown > 0) goalCooldown = Math.max(0, goalCooldown - dt);
      }

      // Move my player
      const me = getMyPlayer();
      const canMove = !ended && (hostId === myId ? countdown <= 0 : countdown <= 0);
      if (me && canMove) {
        let ix = 0,
          iy = 0;
        if (keys.has("w") || keys.has("arrowup")) iy -= 1;
        if (keys.has("s") || keys.has("arrowdown")) iy += 1;
        if (keys.has("a") || keys.has("arrowleft")) ix -= 1;
        if (keys.has("d") || keys.has("arrowright")) ix += 1;
        const len = Math.hypot(ix, iy);
        if (len > 0) {
          ix /= len;
          iy /= len;
          me.lastDirX = ix;
          me.lastDirY = iy;
        }
        // Target velocity
        let tvx = ix * PLAYER_SPEED;
        let tvy = iy * PLAYER_SPEED;

        // If touching another player, slowdown factor based on pushing against them
        for (const other of players.values()) {
          if (other.id === me.id) continue;
          const dx = me.x - other.x;
          const dy = me.y - other.y;
          const d = Math.hypot(dx, dy);
          const minD = PLAYER_R * 2;
          if (d > 0 && d < minD) {
            const nx = dx / d;
            const ny = dy / d;
            // Are we pushing INTO them?
            const push = -(ix * nx + iy * ny); // >0 means pressing into them
            if (push > 0) {
              // Do they push back? (their velocity into us)
              const theirPush = other.vx * -nx + other.vy * -ny;
              const theirPressing = Math.max(0, theirPush) / PLAYER_SPEED; // 0..~1
              const slow = 1 - Math.min(0.9, push * (0.4 + theirPressing * 0.5));
              tvx *= slow;
              tvy *= slow;
              // If they're not pressing back hard, nudge them
              if (theirPressing < 0.6) {
                other.x += -nx * 60 * dt * (1 - theirPressing);
                other.y += -ny * 60 * dt * (1 - theirPressing);
              }
              // Resolve overlap
              const overlap = minD - d;
              me.x += nx * overlap * 0.5;
              me.y += ny * overlap * 0.5;
              other.x -= nx * overlap * 0.5;
              other.y -= ny * overlap * 0.5;
            }
          }
        }

        me.vx = tvx;
        me.vy = tvy;
        me.x += me.vx * dt;
        me.y += me.vy * dt;

        // Clamp to the CANVAS extents (not the field). Players can leave the field
        // (walk behind the goals / into the out-of-bounds strip), but stay on-screen.
        me.x = Math.max(-PAD + PLAYER_R, Math.min(FIELD_W + PAD - PLAYER_R, me.x));
        me.y = Math.max(-PAD + PLAYER_R, Math.min(FIELD_H + PAD - PLAYER_R, me.y));

        // Kick input — direction is from player center toward ball (contact point),
        // so where you hit the ball determines where it goes (like Eggball/Beatball).
        if ((keys.has("x") || keys.has(" ")) && me.kickUntil < now) {
          me.kickUntil = now + KICK_DURATION * 1000;
          const bdx = ball.x - me.x;
          const bdy = ball.y - me.y;
          const bd = Math.hypot(bdx, bdy);
          if (bd > 0 && bd < PLAYER_R + BALL_R + KICK_REACH) {
            const nx = bdx / bd;
            const ny = bdy / bd;
            const nvx = nx * KICK_POWER;
            const nvy = ny * KICK_POWER;
            if (hostId === myId) {
              ball.vx = nvx;
              ball.vy = nvy;
            } else {
              channel.send({ type: "broadcast", event: "kick", payload: { bx: ball.x, by: ball.y, bvx: nvx, bvy: nvy } });
            }
          }
        }
      }

      // Host-only: ball physics
      if (hostId === myId && countdown <= 0 && !ended) {
        // Apply friction
        ball.vx *= Math.pow(BALL_FRICTION, dt * 60);
        ball.vy *= Math.pow(BALL_FRICTION, dt * 60);
        // Clamp
        const bs = Math.hypot(ball.vx, ball.vy);
        if (bs > BALL_MAX) {
          ball.vx = (ball.vx / bs) * BALL_MAX;
          ball.vy = (ball.vy / bs) * BALL_MAX;
        }
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        // Wall collision - but goal openings on left/right
        const inGoalY = ball.y > FIELD_H / 2 - GOAL_H / 2 && ball.y < FIELD_H / 2 + GOAL_H / 2;
        // Left wall / red goal
        if (ball.x - BALL_R < 0) {
          if (inGoalY && goalCooldown <= 0) {
            // Blue scored
            scoreBlue += 1;
            goalCooldown = 3;
            countdown = 3;
            checkEnd();
            resetPositions();
          } else {
            ball.x = BALL_R;
            ball.vx = -ball.vx * 0.7;
          }
        }
        if (ball.x + BALL_R > FIELD_W) {
          if (inGoalY && goalCooldown <= 0) {
            scoreRed += 1;
            goalCooldown = 3;
            countdown = 3;
            checkEnd();
            resetPositions();
          } else {
            ball.x = FIELD_W - BALL_R;
            ball.vx = -ball.vx * 0.7;
          }
        }
        if (ball.y - BALL_R < 0) {
          ball.y = BALL_R;
          ball.vy = -ball.vy * 0.7;
        }
        if (ball.y + BALL_R > FIELD_H) {
          ball.y = FIELD_H - BALL_R;
          ball.vy = -ball.vy * 0.7;
        }

        // Ball vs players: loose realistic push. The ball only gains speed from the
        // component of the player's velocity along the contact normal; it is NOT
        // dragged sideways with the player, and it does NOT stop when the player stops.
        const allPlayers = Array.from(players.values());
        for (const p of allPlayers) {
          const dx = ball.x - p.x;
          const dy = ball.y - p.y;
          const d = Math.hypot(dx, dy);
          const minD = PLAYER_R + BALL_R;
          if (d > 0 && d < minD) {
            const nx = dx / d;
            const ny = dy / d;
            // Resolve overlap (positional only)
            const overlap = minD - d;
            ball.x += nx * overlap;
            ball.y += ny * overlap;

            // Transfer only the player's normal-component speed to the ball, and only
            // if it's greater than the ball's current normal-component speed.
            const playerAlong = p.vx * nx + p.vy * ny;
            const ballAlong = ball.vx * nx + ball.vy * ny;
            if (playerAlong > ballAlong) {
              const delta = playerAlong - ballAlong;
              ball.vx += nx * delta;
              ball.vy += ny * delta;
            }

            // Pinch detection: another player pressing into the ball from the opposite side,
            // AND neither contact is against a wall (pure player-vs-player pinch).
            for (const q of allPlayers) {
              if (q.id === p.id) continue;
              const qdx = ball.x - q.x;
              const qdy = ball.y - q.y;
              const qd = Math.hypot(qdx, qdy);
              if (qd > 0 && qd < minD + 2) {
                const qnx = qdx / qd;
                const qny = qdy / qd;
                if (qnx * nx + qny * ny < -0.5) {
                  const pInto = p.vx * -nx + p.vy * -ny; // p pressing toward ball
                  const qInto = q.vx * -qnx + q.vy * -qny;
                  if (pInto > 40 && qInto > 40) {
                    // Escape perpendicular to the squeeze axis
                    const perpX = -ny;
                    const perpY = nx;
                    // Pick the side further from the field center vertically
                    const sign = ball.y < FIELD_H / 2 ? -1 : 1;
                    ball.vx = perpX * sign * KICK_POWER * 1.1;
                    ball.vy = perpY * sign * KICK_POWER * 1.1;
                  }
                }
              }
            }
          }
        }
      }

      function checkEnd() {
        const lead = Math.abs(scoreRed - scoreBlue);
        if (lead >= MERCY_LEAD) {
          ended = true;
          winner = scoreRed > scoreBlue ? "red" : "blue";
        }
      }

      // Broadcast my player state ~20Hz
      if (me && now - lastBroadcast > 50) {
        lastBroadcast = now;
        const payload: PlayerState = { ...me };
        channel.send({ type: "broadcast", event: "player", payload });
      }

      // Host broadcasts game state ~20Hz
      if (hostId === myId && now - lastStateBroadcast > 50) {
        lastStateBroadcast = now;
        const state: GameState = {
          ball,
          scoreRed,
          scoreBlue,
          timeLeft,
          countdown,
          ended,
          winner,
          hostId,
        };
        channel.send({ type: "broadcast", event: "state", payload: state });
        setScore({ red: scoreRed, blue: scoreBlue, timeLeft, countdown, ended, winner });
      }

      // Purge stale players
      for (const [id, t] of lastSeen) {
        if (now - t > 4000) {
          players.delete(id);
          lastSeen.delete(id);
        }
      }

      draw();
      requestAnimationFrame(tick);
    }

    function draw() {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      // Clear whole canvas (out-of-bounds strip)
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      ctx.save();
      ctx.translate(PAD, PAD);

      // Field background
      ctx.fillStyle = "#1f7a3a";
      ctx.fillRect(0, 0, FIELD_W, FIELD_H);
      // Stripes
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      const stripe = 70;
      for (let i = 0; i < FIELD_W; i += stripe * 2) ctx.fillRect(i, 0, stripe, FIELD_H);
      // Border
      ctx.strokeStyle = "white";
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, FIELD_W - 4, FIELD_H - 4);
      // Center line
      ctx.beginPath();
      ctx.moveTo(FIELD_W / 2, 0);
      ctx.lineTo(FIELD_W / 2, FIELD_H);
      ctx.stroke();
      // Center circle
      ctx.beginPath();
      ctx.arc(FIELD_W / 2, FIELD_H / 2, 70, 0, Math.PI * 2);
      ctx.stroke();
      // Goals (fully visible boxes extending OUT from the field)
      const gy = FIELD_H / 2 - GOAL_H / 2;
      ctx.fillStyle = "rgba(220,50,50,0.30)";
      ctx.fillRect(-GOAL_DEPTH, gy, GOAL_DEPTH, GOAL_H);
      ctx.fillStyle = "rgba(50,110,220,0.30)";
      ctx.fillRect(FIELD_W, gy, GOAL_DEPTH, GOAL_H);
      // Goal posts / frame
      ctx.strokeStyle = "#ff6666";
      ctx.lineWidth = 4;
      ctx.strokeRect(-GOAL_DEPTH, gy, GOAL_DEPTH, GOAL_H);
      ctx.strokeStyle = "#6699ff";
      ctx.strokeRect(FIELD_W, gy, GOAL_DEPTH, GOAL_H);

      // Players
      const now = performance.now();
      const all = Array.from(players.values());
      for (const p of all) {
        const kicking = p.kickUntil > now;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2);
        ctx.fillStyle = p.team === "red" ? "#e23c3c" : "#3c6ee2";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = kicking ? "#ffffff" : "#000000";
        ctx.stroke();
        if (p.id === myId) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, PLAYER_R + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      // Ball
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      ctx.fillStyle = "white";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#333";
      ctx.stroke();

      // Countdown overlay
      if (countdown > 0 && !ended) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);
        ctx.fillStyle = "white";
        ctx.font = "bold 140px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(Math.ceil(countdown)), FIELD_W / 2, FIELD_H / 2);
      }
      if (ended) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, FIELD_W, FIELD_H);
        ctx.fillStyle = "white";
        ctx.font = "bold 64px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text =
          winner === "draw" ? "Draw!" : winner === "red" ? "Red wins!" : winner === "blue" ? "Blue wins!" : "";
        ctx.fillText(text, FIELD_W / 2, FIELD_H / 2);
        ctx.font = "22px sans-serif";
        ctx.fillText(`Final: Red ${scoreRed} - ${scoreBlue} Blue`, FIELD_W / 2, FIELD_H / 2 + 50);
      }

      ctx.restore();
    }

    requestAnimationFrame(tick);

    return () => {
      running = false;
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      channel.send({ type: "broadcast", event: "leave", payload: { id: myId } }).catch(() => {});
      supabase.removeChannel(channel);
    };
  }, []);

  const mm = Math.floor(score.timeLeft / 60);
  const ss = Math.floor(score.timeLeft % 60).toString().padStart(2, "0");

  return (
    <div className="min-h-screen bg-neutral-900 text-white flex flex-col items-center py-4 gap-3">
      <div className="flex items-center gap-6 text-2xl font-bold">
        <span className="text-red-400">RED {score.red}</span>
        <span className="text-neutral-300 text-lg">{mm}:{ss}</span>
        <span className="text-blue-400">{score.blue} BLUE</span>
      </div>
      <div className="relative" style={{ width: CANVAS_W, maxWidth: "100%" }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: "100%", height: "auto", display: "block", borderRadius: 8 }}
        />
        {!joined && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-lg">
            <div className="bg-neutral-800 rounded-xl p-8 shadow-2xl text-center max-w-sm">
              <h1 className="text-3xl font-bold mb-2">Eggball</h1>
              <p className="text-neutral-400 mb-6 text-sm">
                Pick a team to jump in. WASD/arrows to move. X or Space to kick.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => { setTeam("red"); setJoined(true); }}
                  className="px-6 py-3 rounded-lg bg-red-500 hover:bg-red-400 font-bold"
                >
                  Join Red
                </button>
                <button
                  onClick={() => { setTeam("blue"); setJoined(true); }}
                  className="px-6 py-3 rounded-lg bg-blue-500 hover:bg-blue-400 font-bold"
                >
                  Join Blue
                </button>
              </div>
              <p className="mt-4 text-xs text-neutral-500">
                {connected ? "Connected" : "Connecting..."}
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="text-xs text-neutral-500">Move: WASD/Arrows &middot; Kick: X or Space</div>
    </div>
  );
}
