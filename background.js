const SESSION_KEY = "activeSession";

function extractDomain(url) {
    if (!url) {
        return null;
    }

    try {
        const parsed = new URL(url);

        if (
            parsed.protocol !== "http:" &&
            parsed.protocol !== "https:"
        ) {
            return null;
        }

        return parsed.hostname.replace(
            /^www\./,
            ""
        );
    } catch {
        return null;
    }
}

async function getSession() {
    const data =
        await chrome.storage.local.get(
            SESSION_KEY
        );

    return (
        data[SESSION_KEY] || {
            currentDomain: null,
            startTimestamp: null
        }
    );
}

async function setSession(session) {
    await chrome.storage.local.set({
        [SESSION_KEY]: session
    });
}

async function sendSessionToDaemon(
    site,
    startTime,
    endTime,
    durationMs
) {
    return new Promise(
        (resolve, reject) => {
            try {
                const port =
                    chrome.runtime.connectNative(
                        "com.webtracker.host"
                    );

                port.onMessage.addListener(
                    response => {
                        console.log(
                            "Daemon response:",
                            JSON.stringify(
                                response,
                                null,
                                2
                            )
                        );

                        resolve(response);
                    }
                );

                port.onDisconnect.addListener(
                    () => {
                        if (
                            chrome.runtime
                                .lastError
                        ) {
                            reject(
                                chrome.runtime
                                    .lastError
                            );
                        }
                    }
                );

                port.postMessage({
                    type: "session",
                    payload: {
                        site,
                        start_time:
                            startTime,
                        end_time:
                            endTime,
                        duration_ms:
                            durationMs
                    }
                });
            } catch (e) {
                reject(e);
            }
        }
    );
}

async function saveCurrentSession() {
    const session =
        await getSession();

    const {
        currentDomain,
        startTimestamp
    } = session;

    if (
        !currentDomain ||
        !startTimestamp
    ) {
        return;
    }

    const elapsed =
        Date.now() -
        startTimestamp;

    if (elapsed <= 0) {
        return;
    }

    const data =
        await chrome.storage.local.get(
            "siteTimes"
        );

    const siteTimes =
        data.siteTimes || {};

    siteTimes[currentDomain] =
        (siteTimes[currentDomain] || 0)
        + elapsed;

    await chrome.storage.local.set({
        siteTimes
    });

    await setSession({
        currentDomain,
        startTimestamp:
            Date.now()
    });
}

async function stopTracking() {
    const session =
        await getSession();

    const {
        currentDomain,
        startTimestamp
    } = session;

    if (
        !currentDomain ||
        !startTimestamp
    ) {
        return;
    }

    const endTime =
        Date.now();

    const elapsed =
        endTime -
        startTimestamp;

    if (elapsed <= 0) {
        return;
    }

    try {
        await sendSessionToDaemon(
            currentDomain,
            startTimestamp,
            endTime,
            elapsed
        );
    } catch (e) {
        console.error(
            "Failed to send session",
            e
        );
    }

    const data =
        await chrome.storage.local.get(
            "siteTimes"
        );

    const siteTimes =
        data.siteTimes || {};

    siteTimes[currentDomain] =
        (siteTimes[currentDomain] || 0)
        + elapsed;

    await chrome.storage.local.set({
        siteTimes
    });

    await setSession({
        currentDomain: null,
        startTimestamp: null
    });
}

async function handleTab(tab) {
    if (!tab || !tab.url) {
        await stopTracking();
        return;
    }

    const domain =
        extractDomain(tab.url);

    if (!domain) {
        await stopTracking();
        return;
    }

    const data =
        await chrome.storage.local.get(
            "trackedSites"
        );

    const trackedSites =
        data.trackedSites || [];

    const matchedSite =
        trackedSites.find(site =>
            domain === site ||
            domain.endsWith(
                "." + site
            )
        );

    const session =
        await getSession();

    console.log(
        "handleTab",
        {
            domain,
            matchedSite,
            current:
                session.currentDomain
        }
    );
    if (
        session.currentDomain ===
        matchedSite
    ) {
        return;
    }

    await stopTracking();

    if (matchedSite) {
        await setSession({
            currentDomain:
                matchedSite,
            startTimestamp:
                Date.now()
        });

        console.log(
            "Started tracking:",
            matchedSite
        );
    }
}

chrome.tabs.onActivated.addListener(
    async activeInfo => {
        try {
            const tab =
                await chrome.tabs.get(
                    activeInfo.tabId
                );

            await handleTab(tab);
        } catch (e) {
            console.error(e);
        }
    }
);

chrome.tabs.onUpdated.addListener(
    async (
        tabId,
        changeInfo,
        tab
    ) => {
        if (
            changeInfo.status ===
            "complete"
        ) {
            await handleTab(tab);
        }
    }
);

chrome.windows.onFocusChanged.addListener(
    async windowId => {
        try {
            if (
                windowId ===
                chrome.windows
                    .WINDOW_ID_NONE
            ) {
                await stopTracking();
                return;
            }

            const tabs =
                await chrome.tabs.query({
                    active: true,
                    windowId
                });

            if (tabs.length) {
                await handleTab(
                    tabs[0]
                );
            }
        } catch (e) {
            console.error(e);
        }
    }
);

chrome.idle.setDetectionInterval(
    60
);

chrome.idle.onStateChanged.addListener(
    async state => {
        try {
            if (
                state === "idle" ||
                state === "locked"
            ) {
                await stopTracking();
                return;
            }

            if (
                state === "active"
            ) {
                const tabs =
                    await chrome.tabs.query({
                        active: true,
                        lastFocusedWindow: true
                    });

                if (tabs.length) {
                    await handleTab(
                        tabs[0]
                    );
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
);

chrome.alarms.create(
    "flushTracking",
    {
        periodInMinutes: 1
    }
);

chrome.alarms.onAlarm.addListener(
    async alarm => {
        if (
            alarm.name ===
            "flushTracking"
        ) {
            await saveCurrentSession();
        }
    }
);

async function initializeTracking() {
    try {
        const tabs =
            await chrome.tabs.query({
                active: true,
                lastFocusedWindow: true
            });

        if (tabs.length) {
            await handleTab(
                tabs[0]
            );
        }
    } catch (e) {
        console.error(e);
    }
}

chrome.runtime.onInstalled.addListener(
    initializeTracking
);

chrome.runtime.onStartup.addListener(
    initializeTracking
);

chrome.runtime.onSuspend.addListener(
    () => {
        stopTracking();
    }
);