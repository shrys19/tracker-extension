function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);

    const hours =
        Math.floor(totalSeconds / 3600);

    const minutes =
        Math.floor((totalSeconds % 3600) / 60);

    const seconds =
        totalSeconds % 60;

    return `${hours}h ${minutes}m ${seconds}s`;
}

function formatDate() {
    const now = new Date();

    return now
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\..+/, "");
}

function msToHours(ms) {
    return Number(
        (ms / (1000 * 60 * 60))
            .toFixed(2)
    );
}

async function getActiveSession() {
    const data =
        await chrome.storage.local.get(
            "activeSession"
        );

    return (
        data.activeSession || {
            currentDomain: null,
            startTimestamp: null
        }
    );
}

// Durable per-site totals from SQLite (via the daemon). Cached so the
// 1s re-render loop doesn't spawn the native host every tick. Falls
// back to the local siteTimes cache if the daemon is unavailable.
let daemonTimes = {};

async function refreshDaemonTimes() {
    try {
        const resp =
            await chrome.runtime.sendMessage({
                type: "getReport"
            });

        if (
            resp &&
            resp.ok &&
            resp.report &&
            resp.report.sites
        ) {
            const map = {};

            for (const s of resp.report.sites) {
                map[s.site] = s.duration_ms;
            }

            daemonTimes = map;

            return;
        }
    } catch (e) {
        console.error(
            "report fetch failed",
            e
        );
    }

    const data =
        await chrome.storage.local.get(
            "siteTimes"
        );

    daemonTimes = data.siteTimes || {};
}

async function loadData() {
    const data =
        await chrome.storage.local.get(
            "trackedSites"
        );

    const trackedSites =
        data.trackedSites || [];

    // Base totals come from the daemon (durable). The in-progress
    // slice since the last flush is added live below.
    const siteTimes = daemonTimes;

    const activeSession =
        await getActiveSession();

    const siteList =
        document.getElementById(
            "siteList"
        );

    const stats =
        document.getElementById(
            "stats"
        );

    siteList.innerHTML = "";
    stats.innerHTML = "";

    const sitesWithTime = [];

    for (const site of trackedSites) {
        let totalTime =
            siteTimes[site] || 0;

        if (
            activeSession.startTimestamp &&
            activeSession.currentDomain &&
            (
                activeSession.currentDomain === site ||
                activeSession.currentDomain.endsWith("." + site)
            )
        ) {
            totalTime +=
                Date.now() -
                activeSession.startTimestamp;
        }

        sitesWithTime.push({
            site,
            totalTime
        });
    }

    sitesWithTime.sort(
        (a, b) =>
            b.totalTime - a.totalTime
    );

    for (const item of sitesWithTime) {
        const site = item.site;
        const totalTime =
            item.totalTime;

        const li =
            document.createElement("li");

        const removeBtn =
            document.createElement(
                "button"
            );

        removeBtn.textContent =
            "Remove";

        removeBtn.onclick =
            async () => {
                const updated =
                    trackedSites.filter(
                        s => s !== site
                    );

                await chrome.storage.local.set(
                    {
                        trackedSites:
                            updated
                    }
                );

                loadData();
            };

        li.textContent =
            site + " ";

        li.appendChild(removeBtn);

        siteList.appendChild(li);

        const row =
            document.createElement(
                "div"
            );

        const activeMarker =
            activeSession.currentDomain ===
                site
                ? " ● Active"
                : "";

        row.className = "stat-row";

        row.innerHTML = `
    <div>
        <span class="site-name">${site}</span>
        ${activeSession.currentDomain === site
                ? '<span class="active">● Active</span>'
                : ''
            }
    </div>
    <div class="site-time">
        ${formatTime(totalTime)}
    </div>
`;

        stats.appendChild(row);
    }
}

document
    .getElementById("addBtn")
    .addEventListener(
        "click",
        async () => {
            const input =
                document.getElementById(
                    "siteInput"
                );

            const site =
                input.value
                    .trim()
                    .toLowerCase();

            if (!site) {
                return;
            }

            const data =
                await chrome.storage.local.get(
                    "trackedSites"
                );

            const trackedSites =
                data.trackedSites || [];

            if (
                !trackedSites.includes(
                    site
                )
            ) {
                trackedSites.push(
                    site
                );

                await chrome.storage.local.set(
                    {
                        trackedSites
                    }
                );
            }

            input.value = "";

            loadData();
        }
    );

document
    .getElementById("resetBtn")
    .addEventListener(
        "click",
        async () => {
            await chrome.storage.local.set(
                {
                    siteTimes: {}
                }
            );

            loadData();
        }
    );

// Initial paint: pull durable totals from the daemon, then render.
(async () => {
    await refreshDaemonTimes();
    loadData();
})();

// Cheap re-render every second so the active site's time ticks live.
setInterval(() => {
    loadData();
}, 1000);

// Periodically re-pull from the daemon to pick up flushed slices
// (the worker flushes about once a minute).
setInterval(async () => {
    await refreshDaemonTimes();
    loadData();
}, 30000);


document
    .getElementById("exportBtn")
    .addEventListener(
        "click",
        async () => {

            // Pull the full durable export from SQLite via the daemon
            // (per-site totals + every raw session, survives Reset).
            const resp =
                await chrome.runtime.sendMessage({
                    type: "getExport"
                });

            if (!resp || !resp.ok) {
                alert(
                    "Export failed: " +
                    ((resp && resp.error) ||
                        "daemon unavailable")
                );

                return;
            }

            const sites =
                (resp.report &&
                    resp.report.sites) ||
                [];

            const sessions =
                (resp.report &&
                    resp.report.sessions) ||
                [];

            const totalTimeMs =
                sites.reduce(
                    (a, s) =>
                        a + s.duration_ms,
                    0
                );

            const report = {
                generatedAt:
                    new Date().toISOString(),

                source: "sqlite",

                summary: {
                    totalSites:
                        sites.length,

                    totalSessions:
                        sessions.length,

                    totalTimeMs,

                    totalTimeHours:
                        msToHours(
                            totalTimeMs
                        )
                },

                sites: sites.map(s => ({
                    site: s.site,
                    timeMs: s.duration_ms,
                    timeHours:
                        msToHours(
                            s.duration_ms
                        )
                })),

                sessions: sessions.map(s => ({
                    id: s.id,
                    site: s.site,
                    start: new Date(
                        s.start_time
                    ).toISOString(),
                    end: new Date(
                        s.end_time
                    ).toISOString(),
                    startTime: s.start_time,
                    endTime: s.end_time,
                    durationMs: s.duration_ms,
                    durationHours:
                        msToHours(
                            s.duration_ms
                        ),
                    source: s.source,
                    recordedAt: new Date(
                        s.created_at
                    ).toISOString()
                }))
            };

            const blob =
                new Blob(
                    [
                        JSON.stringify(
                            report,
                            null,
                            2
                        )
                    ],
                    {
                        type:
                            "application/json"
                    }
                );

            const url =
                URL.createObjectURL(
                    blob
                );

            const a =
                document.createElement(
                    "a"
                );

            a.href = url;

            a.download =
                `website-tracker-report-${formatDate()}.json`;

            a.click();

            URL.revokeObjectURL(
                url
            );
        }
    );
