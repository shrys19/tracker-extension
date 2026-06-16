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

// Serialize all tracking mutations. Multiple listeners (tab, window,
// idle, alarm) fire concurrently; without this they interleave their
// read-modify-write of the session and flush the same slice twice
// (duplicate rows / double counting) or flap the active session.
let opChain = Promise.resolve();

function serialize(fn) {
    const run = opChain.then(fn, fn);

    opChain = run.catch(() => {});

    return run;
}

// Send one request to the native host and resolve with its reply.
// The daemon reads one message, replies, exits — so we settle exactly
// once on reply, on clean disconnect, on error, or after a timeout.
function sendToDaemon(message) {
    return new Promise(
        (resolve, reject) => {
            let settled = false;

            let port;

            // Always settle exactly once, then close the port.
            const settle = (fn, arg) => {
                if (settled) {
                    return;
                }

                settled = true;

                clearTimeout(timer);

                try {
                    if (port) {
                        port.disconnect();
                    }
                } catch {}

                fn(arg);
            };

            // If the daemon exits cleanly without replying, onDisconnect
            // has no lastError and we must still resolve — otherwise the
            // await hangs.
            const timer = setTimeout(
                () =>
                    settle(
                        reject,
                        new Error(
                            "daemon timeout"
                        )
                    ),
                5000
            );

            try {
                port =
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

                        settle(
                            resolve,
                            response
                        );
                    }
                );

                port.onDisconnect.addListener(
                    () => {
                        const err =
                            chrome.runtime
                                .lastError;

                        if (err) {
                            settle(reject, err);
                        } else {
                            settle(
                                resolve,
                                undefined
                            );
                        }
                    }
                );

                port.postMessage(message);
            } catch (e) {
                settle(reject, e);
            }
        }
    );
}

function sendSessionToDaemon(
    site,
    startTime,
    endTime,
    durationMs
) {
    return sendToDaemon({
        type: "session",
        payload: {
            site,
            start_time: startTime,
            end_time: endTime,
            duration_ms: durationMs
        }
    });
}

// Popup asks for a durable report straight from SQLite (full history,
// survives the local-cache "Reset"). Routed through the worker because
// it owns the native-messaging connection.
chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => {
        if (msg && msg.type === "getReport") {
            sendToDaemon({ type: "report" })
                .then(report =>
                    sendResponse({
                        ok: true,
                        report
                    })
                )
                .catch(e =>
                    sendResponse({
                        ok: false,
                        error: String(
                            (e && e.message) || e
                        )
                    })
                );

            return true; // async sendResponse
        }
    }
);

// Write a time slice to BOTH the local siteTimes cache (live display)
// and the daemon (durable SQLite). The local write happens first and
// unconditionally — tracking must never depend on the daemon being
// installed or responsive. The daemon send is best-effort.
async function flushSlice(
    domain,
    startTime,
    endTime
) {
    const elapsed =
        endTime - startTime;

    if (elapsed <= 0) {
        return;
    }

    const data =
        await chrome.storage.local.get(
            "siteTimes"
        );

    const siteTimes =
        data.siteTimes || {};

    siteTimes[domain] =
        (siteTimes[domain] || 0)
        + elapsed;

    await chrome.storage.local.set({
        siteTimes
    });

    try {
        await sendSessionToDaemon(
            domain,
            startTime,
            endTime,
            elapsed
        );
    } catch (e) {
        console.error(
            "Failed to send session",
            e
        );
    }
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

    const now = Date.now();

    await flushSlice(
        currentDomain,
        startTimestamp,
        now
    );

    await setSession({
        currentDomain,
        startTimestamp: now
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

    await flushSlice(
        currentDomain,
        startTimestamp,
        Date.now()
    );

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
    activeInfo =>
        serialize(async () => {
            try {
                const tab =
                    await chrome.tabs.get(
                        activeInfo.tabId
                    );

                await handleTab(tab);
            } catch (e) {
                console.error(e);
            }
        })
);

chrome.tabs.onUpdated.addListener(
    (tabId, changeInfo, tab) => {
        if (
            changeInfo.status !==
            "complete"
        ) {
            return;
        }

        serialize(() =>
            handleTab(tab)
        );
    }
);

// Note: deliberately do NOT stop tracking on
// WINDOW_ID_NONE. On Linux the action popup steals window focus,
// which would stop the very session the popup is trying to display.
// Idle detection below covers the user actually being away.
chrome.windows.onFocusChanged.addListener(
    windowId =>
        serialize(async () => {
            try {
                if (
                    windowId ===
                    chrome.windows
                        .WINDOW_ID_NONE
                ) {
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
        })
);

chrome.idle.setDetectionInterval(
    60
);

chrome.idle.onStateChanged.addListener(
    state =>
        serialize(async () => {
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
        })
);

chrome.alarms.create(
    "flushTracking",
    {
        periodInMinutes: 1
    }
);

chrome.alarms.onAlarm.addListener(
    alarm => {
        if (
            alarm.name ===
            "flushTracking"
        ) {
            serialize(saveCurrentSession);
        }
    }
);

function initializeTracking() {
    return serialize(async () => {
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
    });
}

chrome.runtime.onInstalled.addListener(
    initializeTracking
);

chrome.runtime.onStartup.addListener(
    initializeTracking
);

chrome.runtime.onSuspend.addListener(
    () => {
        serialize(stopTracking);
    }
);