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

async function loadData() {
    const data =
        await chrome.storage.local.get([
            "trackedSites",
            "siteTimes"
        ]);

    const trackedSites =
        data.trackedSites || [];

    const siteTimes =
        data.siteTimes || {};

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

loadData();

setInterval(() => {
    loadData();
}, 1000);


document
    .getElementById("exportBtn")
    .addEventListener(
        "click",
        async () => {

            const data =
                await chrome.storage.local.get(
                    null
                );

            const trackedSites =
                data.trackedSites || [];

            const siteTimes =
                data.siteTimes || {};

            const activeSession =
                data.activeSession || null;

            const report = {
                generatedAt:
                    new Date().toISOString(),

                trackedSites,

                activeSession,

                summary: {
                    totalSites:
                        trackedSites.length,

                    totalTimeMs:
                        Object.values(
                            siteTimes
                        ).reduce(
                            (a, b) => a + b,
                            0
                        ),

                    totalTimeHours:
                        msToHours(
                            Object.values(
                                siteTimes
                            ).reduce(
                                (a, b) => a + b,
                                0
                            )
                        )
                },

                sites: Object.entries(
                    siteTimes
                )
                    .sort(
                        (a, b) =>
                            b[1] - a[1]
                    )
                    .map(
                        ([site, time]) => ({
                            site,
                            timeMs: time,
                            timeHours:
                                msToHours(
                                    time
                                )
                        })
                    )
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
