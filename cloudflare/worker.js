// Cloudflare Worker: lightweight live sports scores for AWTRIX NG.
// Deploy as a Worker; then use https://YOUR-WORKER.workers.dev/nba/PHI
const LEAGUES = {
  nba: ["basketball", "nba"],
  nfl: ["football", "nfl"],
  mlb: ["baseball", "mlb"],
  nhl: ["hockey", "nhl"],
};
const TZ = "America/New_York";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Additional Eagles Game Center feeds; legacy endpoints remain unchanged.
    if (url.pathname.startsWith("/eagles/gamecenter/")) {
      const kind = url.pathname.split("/")[3];
      if (!["live","standings","weather","weekly"].includes(kind))
        return new Response("Unknown feed",{status:404});
      const cache = caches.default, key = new Request(url.toString());
      const cached = await cache.match(key);
      if (cached) return cached;
      const base = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/";
      const get = async (path) => {
        const r=await fetch(base+path);
        if (!r.ok) throw Error("ESPN "+r.status);
        return r.json();
      };
      const out = (data,seconds=30) => {
        const r=new Response(JSON.stringify(data),{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age="+seconds}});
        ctx.waitUntil(cache.put(key,r.clone()));
        return r;
      };
      try {
        if (kind==="standings") {
          const data=await get("standings");
          const entries=[];
          const walk=(x,group="")=>{
            if (!x || typeof x!=="object") return;
            const label=x.name || x.abbreviation || group;
            if (Array.isArray(x.entries)) for (const e of x.entries) {
              const a=e.team?.abbreviation || "";
              const stats=e.stats || [];
              const stat=(name)=>stats.find(s=>s.name===name || s.abbreviation===name)?.displayValue || "";
              if (a==="PHI") entries.push({team:a,group:label,wins:stat("wins"),losses:stat("losses"),rank:stat("playoffSeed"),record:stat("overall")});
            }
            if (Array.isArray(x.children)) x.children.forEach(y=>walk(y,label));
          };
          walk(data);
          return out({state:entries.length?"ok":"none",eagles:entries[0]||null},900);
        }
        if (kind==="weekly") {
          const data=await get("scoreboard?limit=100");
          const games=(data.events||[]).slice(0,32).map(e=>{
            const c=e.competitions?.[0]?.competitors||[];
            const away=c.find(t=>t.homeAway==="away")||c[0]||{};
            const home=c.find(t=>t.homeAway==="home")||c[1]||{};
            return {away:away.team?.abbreviation||"",home:home.team?.abbreviation||"",
              a:String(away.score??""),h:String(home.score??""),
              state:e.status?.type?.state||"pre",clock:e.status?.displayClock||""};
          });
          const i=Math.max(0,Number.parseInt(url.searchParams.get("index")||"0",10)||0);
          return out({state:games.length?"ok":"none",game:games[i%Math.max(1,games.length)]||null,count:games.length},60);
        }
        const board=await get("scoreboard?limit=100");
        const ev=(board.events||[]).find(e=>(e.competitions?.[0]?.competitors||[]).some(t=>t.team?.abbreviation==="PHI"));
        const comp=ev?.competitions?.[0];
        if (!ev) return out({state:"none"},30);
        const gameId=ev.id;
        const teams=comp?.competitors||[];
        const phi=teams.find(t=>t.team?.abbreviation==="PHI");
        const opp=teams.find(t=>t.team?.abbreviation!=="PHI");
        if (kind==="weather") {
          const w=comp?.weather||ev.weather||{};
          return out({state:w.displayValue||w.temperature||w.conditionId?"ok":"none",
            venue:comp?.venue?.fullName||"",
            temperature:w.temperature??null,condition:w.displayValue||"",
            detail:w.shortDisplayValue||""},600);
        }
        const summary=await get("summary?event="+encodeURIComponent(gameId));
        const sit=summary.drives?.current||summary.header?.competitions?.[0]?.situation||comp?.situation||{};
        const drive=summary.drives?.current||{};
        const last=summary.plays?.[summary.plays.length-1]||drive.plays?.[drive.plays.length-1]||{};
        const possId=sit.possession||drive.team?.id||"";
        const poss=teams.find(t=>String(t.team?.id)===String(possId))?.team?.abbreviation||drive.team?.abbreviation||"";
        const yd=Number(sit.yardLine??sit.possessionText?.match(/\\d+/)?.[0]);
        const down=String(sit.down??""),distance=String(sit.distance??"");
        const redzone=Boolean(sit.isRedZone)||(Number.isFinite(yd)&&yd>=80);
        const stats=[];
        for(const group of summary.boxscore?.players||[]) for(const cat of group.statistics||[]) {
          const labels=cat.labels||[];
          for(const athlete of (cat.athletes||[]).slice(0,4)) {
            const vals=athlete.stats||[];
            if (!vals.length) continue;
            stats.push({team:group.team?.abbreviation||"",name:athlete.athlete?.shortName||athlete.athlete?.displayName||"",
              category:cat.name||"",line:labels.slice(0,3).map((l,i)=>l+":"+String(vals[i]||"")).join(" ").slice(0,60)});
          }
        }
        const play=last.text||sit.lastPlay?.text||"";
        const scoring=Boolean(last.scoringPlay||sit.lastPlay?.scoringPlay);
        const score1=String(phi?.score??"0"),score2=String(opp?.score??"0");
        return out({state:ev.status?.type?.state||"pre",event_id:gameId,
          team:"PHI",opponent:opp?.team?.abbreviation||"",
          score:score1+"-"+score2,phi_score:score1,opp_score:score2,
          down, distance, possession:poss, redzone, yardline:Number.isFinite(yd)?yd:null,
          last_play:play.slice(0,120),scoring_play:scoring,
          play_id:String(last.id||sit.lastPlay?.id||""),
          player_stats:stats.slice(0,24),
          final:ev.status?.type?.state==="post",
          eagles_win:ev.status?.type?.state==="post"&&Number(score1)>Number(score2)},20);
      } catch(e) {
        return new Response(JSON.stringify({state:"error",message:"Feed temporarily unavailable"}),{status:502,headers:{"Content-Type":"application/json"}});
      }
    }
    if (url.pathname === "/eagles/roster") {
      const index = Math.max(0, Math.min(199, Number.parseInt(url.searchParams.get("index") || "0", 10) || 0));
      const cache = caches.default;
      const key = new Request(url.toString(), {method:"GET"});
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const base = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/";
        const sr = await fetch(base + "teams/phi/schedule");
        if (!sr.ok) throw Error("Schedule unavailable");
        const schedule = await sr.json();
        const now = Date.now();
        const events = (schedule.events || []).filter(e => {
          const t = Date.parse(e.date);
          return Number.isFinite(t) && t >= now - 5 * 3600000;
        }).sort((a,b) => Date.parse(a.date) - Date.parse(b.date));
        const event = events[0];
        const teams = event?.competitions?.[0]?.competitors || [];
        const rival = teams.find(t => String(t.team?.abbreviation || "").toUpperCase() !== "PHI");
        const opp = String(rival?.team?.abbreviation || "").toUpperCase();
        if (!opp) return new Response(JSON.stringify({state:"none"}),{headers:{"Content-Type":"application/json"}});
        const side = index % 2 === 0 ? "PHI" : opp;
        const rr = await fetch(base + "teams/" + encodeURIComponent(side.toLowerCase()) + "/roster");
        if (!rr.ok) throw Error("Roster unavailable");
        const roster = await rr.json();
        const players = (roster.athletes || []).flatMap(g => g.items || [])
          .map(p => p.athlete || p)
          .filter(p => p && (p.displayName || p.fullName));
        const player = players[Math.floor(index / 2) % (players.length || 1)];
        const response = new Response(JSON.stringify({
          state: player ? "ok" : "none", team:side,
          name:String(player?.shortName || player?.displayName || player?.fullName || "").slice(0,30),
          number:String(player?.jersey || "").slice(0,4),
          position:String(player?.position?.abbreviation || "").slice(0,5),
          count:players.length, opponent:opp
        }),{headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=300"}});
        ctx.waitUntil(cache.put(key,response.clone()));
        return response;
      } catch(e) {
        return new Response(JSON.stringify({error:"Roster unavailable"}),{status:502,headers:{"Content-Type":"application/json"}});
      }
    }
    if (url.pathname === "/eagles/next") {
      const cache = caches.default;
      const key = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const api = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/phi/schedule";
        const res = await fetch(api, { headers: { "User-Agent": "AWTRIXScoreboard/1.0" } });
        if (!res.ok) throw Error("Schedule HTTP " + res.status);
        const data = await res.json();
        const now = Date.now();
        const upcoming = (data.events || [])
          .filter(e => {
            const state = e.status?.type?.state || e.competitions?.[0]?.status?.type?.state || "pre";
            return state === "pre" && Date.parse(e.date) > now;
          })
          .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
        const event = upcoming[0];
        const competitors = event?.competitions?.[0]?.competitors || [];
        const opponent = competitors.find(t => String(t.team?.abbreviation || "").toUpperCase() !== "PHI");
        const response = new Response(JSON.stringify({
          state: event ? "pre" : "none",
          kickoff_s: event ? Math.floor(Date.parse(event.date) / 1000) : 0,
          opponent: String(opponent?.team?.abbreviation || ""),
          updated_s: Math.floor(now / 1000)
        }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
        ctx.waitUntil(cache.put(key, response.clone()));
        return response;
      } catch (e) {
        return new Response(JSON.stringify({error:"Schedule temporarily unavailable"}), {status:502,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
      }
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || !LEAGUES[parts[0]] || !/^[A-Z]{2,4}$/.test(parts[1])) {
      return new Response("Use /nba/PHI, /nfl/PHI, /mlb/PHI, or /nhl/PHI", { status: 400 });
    }
    const [sport, team] = parts;
    const cache = caches.default;
    const key = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(key);
    if (cached) return cached;
    const [category, league] = LEAGUES[sport];
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date()).replaceAll("-", "");
    const api = `https://site.api.espn.com/apis/site/v2/sports/${category}/${league}/scoreboard?limit=100&dates=${day}`;
    try {
      const res = await fetch(api, { headers: { "User-Agent": "AWTRIXScoreboard/1.0" } });
      if (!res.ok) throw Error("ESPN HTTP " + res.status);
      const feed = await res.json();
      let selected = null;
      for (const event of feed.events || []) {
        const teams = event.competitions?.[0]?.competitors || [];
        const abbr = t => String(t?.team?.abbreviation || "").toUpperCase();
        if (!teams.some(t => abbr(t) === team)) continue;
        const status = event.status || {};
        const state = status.type?.state || "pre";
        const away = teams.find(t => t.homeAway === "away") || teams[0];
        const home = teams.find(t => t.homeAway === "home") || teams[1];
        const game = {
          state, team1: abbr(away), points1: String(away?.score ?? "0"),
          team2: abbr(home), points2: String(home?.score ?? "0"),
          period: String(status.period || 0),
          clock: String(status.displayClock || "").slice(0, 10),
          detail: String(status.type?.shortDetail || "").slice(0, 64),
          date: event.date || "",
        };
        if (!selected || (state === "in" && selected.state !== "in") ||
            (state === "post" && selected.state === "pre")) selected = game;
      }
      const now = Date.now();
      const output = {
        sport, team, updated: new Date(now).toISOString(), updated_s: Math.floor(now / 1000),
        updated_ms: now, state: selected?.state || "none",
        team1: selected?.team1 || "", points1: selected?.points1 || "",
        team2: selected?.team2 || "", points2: selected?.points2 || "",
        period: selected?.period || "", clock: selected?.clock || "",
        detail: selected?.detail || "",
        score: selected ? `${selected.team1} ${selected.points1} ${selected.team2} ${selected.points2}` : "",
        next: selected?.state === "pre" ? selected.date : ""
      };
      const response = new Response(JSON.stringify(output), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=20" }
      });
      ctx.waitUntil(cache.put(key, response.clone()));
      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: "Live score unavailable" }), {
        status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
  }
};
