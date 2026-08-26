import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL || "https://mos-sport.explaingpt.ru/api"
).replace(/\/$/, "");
const consentDocumentFilename = "81758d52-3d00-45ae-a7ca-ba526f3d45c1.docx";
const consentDocumentUrl = `${import.meta.env.BASE_URL}${consentDocumentFilename}`;
const consentClientIdStorageKey = "mosSportConsentClientId";
const consentAcceptedStorageKey = "mosSportConsentAccepted";
const supportedEventTypes = [
  "free_play",
  "masterclass",
  "tournament_60",
  "tournament_120",
  "tournament_180",
];
const eventTypeOrder = [
  "free_play",
  "masterclass",
  "tournament_60",
  "tournament_120",
  "tournament_180",
];
const eventTypeLabels = {
  free_play: "Свободная игра",
  masterclass: "Мастер-класс",
  tournament_60: "Турнир 60 минут",
  tournament_120: "Турнир 120 минут",
  tournament_180: "Турнир 180 минут",
};
const venueCatalog = {
  12: {
    id: "12",
    title: "Баррикадная",
    courts: {
      10: "Корт 1",
      11: "Корт 2",
    },
  },
  14: {
    id: "14",
    title: "Третьяковская",
    courts: {
      12: "Корт 1",
      13: "Корт 2",
    },
  },
  15: {
    id: "15",
    title: "Римская",
    courts: {
      14: "Корт 1",
      15: "Корт 2",
    },
  },
};
const initialProfile = {
  first_name: "",
  last_name: "",
  phone: "",
  email: "",
  privacy_policy_accepted: true,
  personal_data_accepted: true,
};

function createUrl(url, query) {
  const requestUrl = new URL(`${apiBaseUrl}${url}`, window.location.origin);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    requestUrl.searchParams.set(key, value);
  });

  return requestUrl.toString();
}

async function requestJson(url, method, body, query) {
  try {
    const response = await fetch(createUrl(url, query), {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await response.json();
      return {
        httpStatus: response.status,
        ...json,
      };
    }

    const rawText = await response.text();
    return {
      httpStatus: response.status,
      status: response.status,
      data: {
        raw_text: rawText,
      },
    };
  } catch (error) {
    return {
      httpStatus: 502,
      status: 502,
      data: {
        error: "fetch_failed",
        message:
          error instanceof Error ? error.message : "Неизвестная ошибка сети",
      },
    };
  }
}

async function requestConsent(method, body, query) {
  const primary = await requestJson("/consent", method, body, query);

  if (primary.httpStatus !== 404) {
    return primary;
  }

  return requestJson("/consent-status", method, body, query);
}

function getResponseData(response) {
  if (!response) {
    return {};
  }

  if (response.data !== undefined) {
    return response.data;
  }

  return response;
}

function getFirstErrorMessage(payload) {
  const data = getResponseData(payload);

  if (Array.isArray(data?.errors) && data.errors[0]?.message) {
    return String(data.errors[0].message);
  }

  if (data?.message) {
    return String(data.message);
  }

  if (typeof data?.raw_text === "string" && data.raw_text.trim()) {
    return data.raw_text.trim();
  }

  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }

  return "Неизвестная ошибка";
}

function isSessionExpiredResponse(payload) {
  const message = getFirstErrorMessage(payload);
  return (
    message.includes("Registration session is not active") ||
    message.includes("Registration session expired")
  );
}

function getEventTypeLabel(eventType, fallbackTitle) {
  return fallbackTitle || eventTypeLabels[eventType] || eventType || "—";
}

function getVenueTitle(venueId) {
  return venueCatalog[String(venueId)]?.title || `Площадка ${venueId}`;
}

function getCourtTitle(venueId, courtId, fallbackTitle) {
  return (
    venueCatalog[String(venueId)]?.courts?.[String(courtId)] ||
    fallbackTitle ||
    `Корт ${courtId}`
  );
}

function formatDateToYmd(dateValue) {
  const date = new Date(dateValue);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

function buildSearchDates(daysCount = 4, startValue = Date.now()) {
  const dates = [];
  const baseDate = new Date(startValue);

  for (let index = 0; index < daysCount; index += 1) {
    const nextDate = new Date(baseDate);
    nextDate.setDate(baseDate.getDate() + index);
    dates.push(formatDateToYmd(nextDate));
  }

  return dates;
}

function formatDateHuman(dateString) {
  if (!dateString) {
    return "—";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "long",
  }).format(new Date(`${dateString}T00:00:00+03:00`));
}

function formatDateTimeHuman(value) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTimeHuman(value) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRemaining(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "00:00";
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getMoscowClock(dateValue = Date.now()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date(dateValue));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const hours = Number(values.hour || 0);

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    floorMinutes: hours * 60,
  };
}

function parseTimeToMinutes(time) {
  if (!time || !time.includes(":")) {
    return null;
  }

  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function isPastSlot(slot, nowValue) {
  if (!slot?.starts_at) {
    return false;
  }

  const moscowNow = getMoscowClock(nowValue);
  const slotDate = slot.starts_at.slice(0, 10);
  const slotMinutes = parseTimeToMinutes(slot.starts_at.slice(11, 16));

  if (slotDate !== moscowNow.date || slotMinutes === null) {
    return false;
  }

  return slotMinutes < moscowNow.floorMinutes;
}

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function buildSlotKey(slot) {
  return [
    slot.event_type,
    slot.venue_id,
    slot.court_id,
    slot.event_id,
    slot.starts_at,
    slot.duration_minutes,
  ].join(":");
}

function normalizeSlot(eventType, venueId, court, event, slot, serverNow) {
  const startsAt = slot?.starts_at || event?.starts_at || "";
  const endsAt = slot?.ends_at || event?.ends_at || "";
  const availableTickets =
    Number(slot?.available_tickets ?? slot?.raw_available_tickets ?? 0) || 0;
  const bookingOpen =
    slot?.booking_open === true ||
    !slot?.booking_opens_at ||
    !serverNow ||
    new Date(serverNow).getTime() >= new Date(slot.booking_opens_at).getTime();

  if (!startsAt || !endsAt || availableTickets <= 0) {
    return null;
  }

  const normalizedSlot = {
    event_type: eventType,
    event_title: getEventTypeLabel(eventType, event.title),
    event_description: event.description || "",
    event_capacity: Number(event.capacity || 0) || 0,
    venue_id: String(venueId),
    venue_title: getVenueTitle(venueId),
    court_id: String(court.court_id),
    court_title: getCourtTitle(
      venueId,
      court.court_id,
      court.court_title || `Корт ${court.court_number || court.court_id}`,
    ),
    event_id: event.event_id || event.id,
    starts_at: startsAt,
    ends_at: endsAt,
    date: startsAt.slice(0, 10),
    time: slot.time || startsAt.slice(11, 16),
    duration_minutes: Number(slot.duration_minutes) || 0,
    available_tickets: availableTickets,
    raw_available_tickets:
      Number(slot?.raw_available_tickets ?? availableTickets) ||
      availableTickets,
    booking_opens_at: slot?.booking_opens_at || "",
    booking_open: bookingOpen === null ? false : Boolean(bookingOpen),
    enabled: null,
  };

  return {
    ...normalizedSlot,
    key: buildSlotKey(normalizedSlot),
  };
}

function extractSlotsFromDateOptions(response, venueId) {
  const payload = getResponseData(response);
  const eventType = payload?.event_type || response.event_type;
  const courts = Array.isArray(payload?.courts) ? payload.courts : [];
  const serverNow = payload?.server_now || "";

  return courts.flatMap((court) =>
    (court.available_events || []).flatMap((event) =>
      (event.available_slots || [])
        .map((slot) =>
          normalizeSlot(eventType, venueId, court, event, slot, serverNow),
        )
        .filter(Boolean),
    ),
  );
}

function extractSlotsFromAvailability(response, context) {
  const payload = getResponseData(response);
  const events = Array.isArray(payload?.events) ? payload.events : [];

  return events
    .flatMap((event) =>
      (event.starts || []).flatMap((start) =>
        Object.entries(start.durations || {}).map(
          ([durationKey, durationValue]) => {
            const availableTickets =
              Number(
                durationValue?.available_tickets ??
                  durationValue?.raw_available_tickets ??
                  0,
              ) || 0;

            if (availableTickets <= 0) {
              return null;
            }

            const normalizedSlot = {
              event_type: event.event_type || context.event_type,
              event_title: getEventTypeLabel(
                event.event_type || context.event_type,
                event.title,
              ),
              event_description: event.description || "",
              event_capacity: Number(event.capacity || 0) || 0,
              venue_id: String(context.venue_id),
              venue_title: getVenueTitle(context.venue_id),
              court_id: String(context.court_id),
              court_title: getCourtTitle(context.venue_id, context.court_id),
              event_id: Number(event.event_id || event.id || 0),
              starts_at: start.starts_at || "",
              ends_at: durationValue?.ends_at || "",
              date: String(context.date),
              time: start.time || String(start.starts_at || "").slice(11, 16),
              duration_minutes: Number(durationKey),
              available_tickets: availableTickets,
              raw_available_tickets:
                Number(
                  durationValue?.raw_available_tickets ?? availableTickets,
                ) || availableTickets,
              booking_opens_at: "",
              booking_open:
                durationValue?.booking_open === undefined
                  ? false
                  : Boolean(durationValue.booking_open),
              enabled:
                durationValue?.enabled === undefined
                  ? null
                  : Boolean(durationValue.enabled),
            };

            return {
              ...normalizedSlot,
              key: buildSlotKey(normalizedSlot),
            };
          },
        ),
      ),
    )
    .filter(Boolean);
}

function mergeSlotsByStatus(baseSlots, availabilitySlots) {
  const slotMap = new Map(baseSlots.map((slot) => [slot.key, { ...slot }]));

  availabilitySlots.forEach((slot) => {
    const current = slotMap.get(slot.key);

    if (!current) {
      slotMap.set(slot.key, { ...slot });
      return;
    }

    slotMap.set(slot.key, {
      ...current,
      event_description: slot.event_description || current.event_description,
      event_capacity:
        Number(slot.event_capacity) || Number(current.event_capacity) || 0,
      available_tickets: Math.max(
        Number(current.available_tickets) || 0,
        Number(slot.available_tickets) || 0,
      ),
      raw_available_tickets: Math.max(
        Number(current.raw_available_tickets) || 0,
        Number(slot.raw_available_tickets) || 0,
      ),
      booking_open: slot.booking_open,
      enabled: slot.enabled ?? current.enabled,
    });
  });

  return sortSlots(Array.from(slotMap.values()));
}

function sortSlots(slots) {
  return [...slots].sort((left, right) => {
    const eventTypeDiff =
      eventTypeOrder.indexOf(left.event_type) -
      eventTypeOrder.indexOf(right.event_type);
    if (eventTypeDiff !== 0) {
      return eventTypeDiff;
    }

    const dateDiff = left.date.localeCompare(right.date);
    if (dateDiff !== 0) {
      return dateDiff;
    }

    const courtDiff = left.court_title.localeCompare(right.court_title, "ru");
    if (courtDiff !== 0) {
      return courtDiff;
    }

    const timeDiff = left.time.localeCompare(right.time);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.duration_minutes - right.duration_minutes;
  });
}

function getSlotVisualStatus(slot) {
  return slot.booking_open === true && slot.enabled === false
    ? "disabled"
    : "ready";
}

async function loadVenueSlotsForNextDays(venueId) {
  const results = await Promise.all(
    supportedEventTypes.map(async (eventType) => {
      const response = await requestJson("/date-options", "GET", undefined, {
        event_type: eventType,
        venue_id: venueId,
      });

      return {
        ...response,
        event_type: eventType,
      };
    }),
  );

  const successfulResponses = results.filter(
    (response) => response.httpStatus < 400,
  );
  const serverNow =
    successfulResponses
      .map((response) => getResponseData(response))
      .find((payload) => payload?.server_now)?.server_now ||
    new Date().toISOString();

  const searchDates = buildSearchDates(4, serverNow);
  const searchDatesSet = new Set(searchDates);

  const baseSlots = sortSlots(
    successfulResponses
      .flatMap((response) => extractSlotsFromDateOptions(response, venueId))
      .filter((slot) => searchDatesSet.has(slot.date)),
  );

  const venueCourtIds = Object.keys(
    venueCatalog[String(venueId)]?.courts || {},
  );
  const availabilityQueries = searchDates.flatMap((date) =>
    supportedEventTypes.flatMap((eventType) =>
      venueCourtIds.map((court_id) => ({
        event_type: eventType,
        venue_id: String(venueId),
        court_id: String(court_id),
        date,
      })),
    ),
  );

  const availabilityResponses = await Promise.all(
    availabilityQueries.map(async (query) => {
      const response = await requestJson(
        "/availability",
        "GET",
        undefined,
        query,
      );
      return {
        ...response,
        context: query,
      };
    }),
  );

  const availabilitySlots = availabilityResponses
    .filter((response) => response.httpStatus < 400)
    .flatMap((response) =>
      extractSlotsFromAvailability(response, response.context),
    );

  return {
    serverNow,
    slots: mergeSlotsByStatus(baseSlots, availabilitySlots).filter(
      (slot) => searchDatesSet.has(slot.date) && slot.booking_open === true,
    ),
    hasSuccess:
      successfulResponses.length > 0 ||
      availabilityResponses.some((response) => response.httpStatus < 400),
  };
}

function buildVenueSections(slots) {
  const eventTypeMap = new Map();

  slots.forEach((slot) => {
    if (!eventTypeMap.has(slot.event_type)) {
      eventTypeMap.set(slot.event_type, {
      eventType: slot.event_type,
      title: getEventTypeLabel(slot.event_type, slot.event_title),
      description: slot.event_description || "",
      capacity: Number(slot.event_capacity) || 0,
      datesMap: new Map(),
    });
    }

    const eventTypeGroup = eventTypeMap.get(slot.event_type);

    if (!eventTypeGroup.datesMap.has(slot.date)) {
      eventTypeGroup.datesMap.set(slot.date, {
        date: slot.date,
        label: formatDateHuman(slot.date),
        courtsMap: new Map(),
      });
    }

    const dateGroup = eventTypeGroup.datesMap.get(slot.date);

    if (!dateGroup.courtsMap.has(slot.court_id)) {
      dateGroup.courtsMap.set(slot.court_id, {
        courtId: slot.court_id,
        courtTitle: slot.court_title,
        slots: [],
      });
    }

    dateGroup.courtsMap.get(slot.court_id).slots.push(slot);
  });

  return eventTypeOrder
    .filter((eventType) => eventTypeMap.has(eventType))
    .map((eventType) => {
      const eventTypeGroup = eventTypeMap.get(eventType);
      return {
        eventType,
        title: eventTypeGroup.title,
        description: eventTypeGroup.description,
        capacity: eventTypeGroup.capacity,
        dates: Array.from(eventTypeGroup.datesMap.values())
          .sort((left, right) => left.date.localeCompare(right.date))
          .map((dateGroup) => ({
            date: dateGroup.date,
            label: dateGroup.label,
            courts: Array.from(dateGroup.courtsMap.values()).sort(
              (left, right) =>
                left.courtTitle.localeCompare(right.courtTitle, "ru"),
            ),
          })),
      };
    });
}

function useToasts() {
  const [toasts, setToasts] = useState([]);

  function removeToast(id) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function pushToast(type, title, message, code) {
    const id = `${Date.now()}:${Math.random()}`;
    const duration = type === "success" ? 2000 : 4000;

    setToasts((current) => [
      ...current,
      {
        id,
        type,
        title,
        message,
        code,
      },
    ]);

    window.setTimeout(() => {
      removeToast(id);
    }, duration);
  }

  return {
    toasts,
    pushToast,
    removeToast,
  };
}

function ensureConsentClientId() {
  const existingId = window.localStorage.getItem(consentClientIdStorageKey);
  if (existingId) {
    return existingId;
  }

  const nextId =
    window.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(consentClientIdStorageKey, nextId);
  return nextId;
}

function useConsentGate(pushToast) {
  const [status, setStatus] = useState("loading");
  const [messageMode, setMessageMode] = useState("initial");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const nextClientId = ensureConsentClientId();
    setClientId(nextClientId);

    void (async () => {
      const response = await requestConsent("GET", undefined, {
        client_id: nextClientId,
      });

      if (
        response.httpStatus === 200 &&
        getResponseData(response)?.accepted === true
      ) {
        window.localStorage.setItem(consentAcceptedStorageKey, "true");
        setStatus("accepted");
        return;
      }

      if (response.httpStatus === 404) {
        window.localStorage.removeItem(consentAcceptedStorageKey);
        setStatus("required");
        return;
      }

      const localAccepted =
        window.localStorage.getItem(consentAcceptedStorageKey) === "true";
      setStatus(localAccepted ? "accepted" : "required");
    })();
  }, []);

  async function acceptConsent() {
    if (!clientId) {
      return;
    }

    setBusy(true);
    const response = await requestConsent("POST", {
      client_id: clientId,
      accepted: true,
    });

    if (
      response.httpStatus === 200 &&
      getResponseData(response)?.accepted === true
    ) {
      window.localStorage.setItem(consentAcceptedStorageKey, "true");
      setStatus("accepted");
      setMessageMode("initial");
      setBusy(false);
      return;
    }

    if (response.httpStatus >= 500 || response.httpStatus === 502) {
      window.localStorage.setItem(consentAcceptedStorageKey, "true");
      setStatus("accepted");
      setMessageMode("initial");
      pushToast(
        "success",
        "Согласие сохранено локально",
        "Сервер сейчас недоступен, поэтому доступ открыт по локальному подтверждению.",
      );
      setBusy(false);
      return;
    }

    pushToast(
      "error",
      "Не удалось сохранить согласие",
      getFirstErrorMessage(response),
      response.httpStatus,
    );
    setBusy(false);
  }

  function declineConsent() {
    setMessageMode("declined");
    setStatus("required");
  }

  return {
    status,
    messageMode,
    busy,
    acceptConsent,
    declineConsent,
  };
}

export default function App() {
  const { toasts, pushToast, removeToast } = useToasts();
  const consent = useConsentGate(pushToast);

  return (
    <div className="page-shell">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/venue/:venueId"
          element={<VenuePage pushToast={pushToast} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ConsentOverlay consent={consent} />
      <ToastViewport toasts={toasts} onClose={removeToast} />
    </div>
  );
}

function HomePage() {
  const venues = Object.values(venueCatalog);
  const [slotCounts, setSlotCounts] = useState({});

  useEffect(() => {
    void (async () => {
      const entries = await Promise.all(
        venues.map(async (venue) => {
          const { slots } = await loadVenueSlotsForNextDays(venue.id);
          const slotsCount = slots.length;

          return [venue.id, slotsCount];
        }),
      );

      setSlotCounts(Object.fromEntries(entries));
    })();
  }, []);

  return (
    <main className="layout layout-home">
      <section className="hero-card">
        <p className="hero-kicker">Padel · Москва</p>
        <h1>Быстрый выбор записи</h1>
        <p className="hero-text">
          Сначала выберите площадку. На следующем экране будут показаны только
          те времена, где уже есть свободные места и можно переходить к записи.
        </p>
      </section>

      <section className="venue-grid">
        {venues.map((venue) => (
          <Link key={venue.id} to={`/venue/${venue.id}`} className="venue-card">
            <span className="venue-title">{venue.title}</span>
            <span className="venue-meta">
              {slotCounts[venue.id] === undefined
                ? "Считаем свободные слоты…"
                : `${slotCounts[venue.id]} свободных слотов`}
            </span>
            <span className="venue-arrow">Перейти к слотам →</span>
          </Link>
        ))}
      </section>
    </main>
  );
}

function VenuePage({ pushToast }) {
  const { venueId = "" } = useParams();
  const venue = venueCatalog[String(venueId)];
  const [slots, setSlots] = useState([]);
  const [loadingState, setLoadingState] = useState("idle");
  const [lastUpdatedAt, setLastUpdatedAt] = useState("");
  const [requestedTickets, setRequestedTickets] = useState(1);
  const [selectedSlotKey, setSelectedSlotKey] = useState("");
  const [profile, setProfile] = useState(initialProfile);
  const [sessionId, setSessionId] = useState("");
  const [holdId, setHoldId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [availableBeforeHold, setAvailableBeforeHold] = useState(null);
  const [availableAfterHold, setAvailableAfterHold] = useState(null);
  const [smsCode, setSmsCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [smsCooldownUntil, setSmsCooldownUntil] = useState(null);
  const [loadingStep, setLoadingStep] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 30000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!venue) {
      return;
    }

    loadSlots();
  }, [venueId]);

  const futureSlots = useMemo(
    () => sortSlots(slots.filter((slot) => !isPastSlot(slot, now))),
    [now, slots],
  );

  const maxTicketsAvailable = useMemo(() => {
    if (!futureSlots.length) {
      return 1;
    }

    return Math.max(
      ...futureSlots.map((slot) => Number(slot.available_tickets) || 1),
    );
  }, [futureSlots]);

  const visibleSlots = useMemo(() => {
    return futureSlots.filter(
      (slot) => Number(slot.available_tickets) >= requestedTickets,
    );
  }, [futureSlots, requestedTickets]);

  const selectedSlot = useMemo(
    () => visibleSlots.find((slot) => slot.key === selectedSlotKey) || null,
    [selectedSlotKey, visibleSlots],
  );

  const sections = useMemo(
    () => buildVenueSections(visibleSlots),
    [visibleSlots],
  );

  const expiresInSeconds = useMemo(() => {
    if (!expiresAt) {
      return null;
    }

    return Math.max(
      0,
      Math.floor((new Date(expiresAt).getTime() - now) / 1000),
    );
  }, [expiresAt, now]);

  const smsRetryInSeconds = useMemo(() => {
    if (!smsCooldownUntil) {
      return 0;
    }

    return Math.max(0, Math.ceil((smsCooldownUntil - now) / 1000));
  }, [now, smsCooldownUntil]);

  useEffect(() => {
    if (!visibleSlots.some((slot) => slot.key === selectedSlotKey)) {
      setSelectedSlotKey("");
    }
  }, [selectedSlotKey, visibleSlots]);

  useEffect(() => {
    if (requestedTickets > maxTicketsAvailable) {
      setRequestedTickets(maxTicketsAvailable);
    }
  }, [maxTicketsAvailable, requestedTickets]);

  useEffect(() => {
    resetFlow();
  }, [selectedSlotKey]);

  if (!venue) {
    return <Navigate to="/" replace />;
  }

  function resetFlow() {
    setSessionId("");
    setHoldId("");
    setExpiresAt("");
    setAvailableBeforeHold(null);
    setAvailableAfterHold(null);
    setVerified(false);
    setSmsCode("");
    setSmsCooldownUntil(null);
    setLoadingStep("");
  }

  function updateProfile(event) {
    const { name, value, type, checked } = event.target;
    setProfile((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function loadSlots() {
    setLoadingState("loading");

    const result = await loadVenueSlotsForNextDays(venueId);
    setSlots(result.slots);
    setLastUpdatedAt(result.serverNow || new Date().toISOString());

    if (!result.hasSuccess) {
      setLoadingState("error");
      pushToast(
        "error",
        "Не удалось загрузить слоты",
        "Сервис временно не отвечает.",
      );
      return;
    }

    setLoadingState("success");
  }

  async function handleHold() {
    if (!selectedSlot) {
      pushToast(
        "error",
        "Слот не выбран",
        "Сначала выберите время на площадке.",
      );
      return;
    }

    setLoadingStep("hold");

    const sessionResponse = await requestJson("/session", "POST", {
      event_type: selectedSlot.event_type,
      venue_id: Number(selectedSlot.venue_id),
      court_id: Number(selectedSlot.court_id),
      date: selectedSlot.date,
    });

    if (sessionResponse.httpStatus >= 400) {
      pushToast(
        "error",
        "Не удалось создать сессию",
        getFirstErrorMessage(sessionResponse),
        sessionResponse.httpStatus,
      );
      setLoadingStep("");
      return;
    }

    const sessionData = getResponseData(sessionResponse);
    const nextSessionId = String(sessionData.session_id || "");

    setSessionId(nextSessionId);
    setExpiresAt(sessionData.expires_at || "");

    const holdResponse = await requestJson("/hold", "PUT", {
      session_id: nextSessionId,
      event_id: Number(selectedSlot.event_id),
      starts_at: selectedSlot.starts_at,
      ends_at: selectedSlot.ends_at,
      duration_minutes: Number(selectedSlot.duration_minutes),
      tickets_count: requestedTickets,
    });

    if (holdResponse.httpStatus >= 400) {
      pushToast(
        "error",
        "Не удалось удержать слот",
        getFirstErrorMessage(holdResponse),
        holdResponse.httpStatus,
      );
      setLoadingStep("");
      return;
    }

    const holdData = getResponseData(holdResponse);
    setHoldId(String(holdData.hold_id || ""));
    setSessionId(String(holdData.session_id || nextSessionId));
    setExpiresAt(holdData.expires_at || sessionData.expires_at || "");
    setAvailableBeforeHold(holdData.available_tickets_before_hold ?? null);
    setAvailableAfterHold(holdData.available_tickets_after_hold ?? null);
    pushToast("success", "Слот удержан", "Теперь можно запросить SMS-код.");
    setLoadingStep("");
  }

  async function handleSmsSend() {
    if (!sessionId || !holdId) {
      pushToast("error", "Нет активного удержания", "Сначала удержите слот.");
      return;
    }

    if (!profile.phone.trim()) {
      pushToast(
        "error",
        "Нужен телефон",
        "Введите номер телефона для получения SMS.",
      );
      return;
    }

    setLoadingStep("smsSend");

    const response = await requestJson("/sms-send", "POST", {
      session_id: sessionId,
      hold_id: holdId,
      phone: profile.phone.trim(),
    });

    if (response.httpStatus >= 400) {
      pushToast(
        "error",
        "Не удалось отправить SMS",
        getFirstErrorMessage(response),
        response.httpStatus,
      );
      setLoadingStep("");
      return;
    }

    const data = getResponseData(response);

    if (toPositiveNumber(data.retry_after_seconds) > 0) {
      setSmsCooldownUntil(Date.now() + Number(data.retry_after_seconds) * 1000);
    }

    pushToast("success", "SMS отправлено", "Введите код из сообщения.");
    setLoadingStep("");
  }

  async function handleSmsVerify() {
    if (!sessionId || !holdId) {
      pushToast("error", "Нет активного удержания", "Сначала удержите слот.");
      return;
    }

    if (!profile.phone.trim() || !smsCode.trim()) {
      pushToast("error", "Не хватает данных", "Введите телефон и SMS-код.");
      return;
    }

    setLoadingStep("smsVerify");

    const response = await requestJson("/sms-verify", "POST", {
      session_id: sessionId,
      hold_id: holdId,
      phone: profile.phone.trim(),
      code: smsCode.trim(),
      otp: smsCode.trim(),
    });

    const data = getResponseData(response);

    if (response.httpStatus >= 400 || data?.status !== "verified") {
      pushToast(
        "error",
        "Код не подтверждён",
        getFirstErrorMessage(response),
        response.httpStatus,
      );
      setVerified(false);
      setLoadingStep("");
      return;
    }

    setVerified(true);
    pushToast("success", "Код подтверждён", "Можно завершать запись.");
    setLoadingStep("");
  }

  async function handleConfirm() {
    if (!verified) {
      pushToast("error", "Код не подтверждён", "Сначала подтвердите SMS-код.");
      return;
    }

    if (
      !profile.first_name.trim() ||
      !profile.last_name.trim() ||
      !profile.phone.trim() ||
      !profile.email.trim()
    ) {
      pushToast(
        "error",
        "Не хватает данных",
        "Заполните имя, фамилию, телефон и почту.",
      );
      return;
    }

    setLoadingStep("confirm");

    const response = await requestJson("/confirm", "POST", {
      session_id: sessionId,
      hold_id: holdId,
      first_name: profile.first_name.trim(),
      last_name: profile.last_name.trim(),
      phone: profile.phone.trim(),
      email: profile.email.trim(),
      privacy_policy_accepted: profile.privacy_policy_accepted,
      personal_data_accepted: profile.personal_data_accepted,
    });

    if (response.httpStatus >= 400) {
      pushToast(
        "error",
        isSessionExpiredResponse(response)
          ? "Сессия истекла"
          : "Не удалось подтвердить запись",
        isSessionExpiredResponse(response)
          ? "Сессия истекла, повторите цепочку с начала."
          : getFirstErrorMessage(response),
        response.httpStatus,
      );
      setLoadingStep("");
      return;
    }

    pushToast(
      "success",
      "Запись подтверждена",
      "Проверьте итог на стороне сервиса.",
    );
    setLoadingStep("");
  }

  return (
    <main className="layout layout-venue">
      <section className="page-topbar">
        <div>
          <Link className="back-link" to="/">
            ← Все площадки
          </Link>
          <h1>{venue.title}</h1>
          <p className="page-description">
            Выберите удобное время. Ниже показываются только доступные варианты
            с открытой записью и нужным вам количеством мест.
          </p>
        </div>

        <div className="page-actions">
          <div className="page-updated-at">
            Обновлено: {formatDateTimeHuman(lastUpdatedAt)}
          </div>
          <button
            type="button"
            onClick={loadSlots}
            disabled={loadingState === "loading"}
          >
            {loadingState === "loading" ? "Обновление…" : "Обновить"}
          </button>
        </div>
      </section>

      <section className="venue-content">
        <div className="slots-column">
          <section className="legend-card">
            <div className="legend-title">Легенда</div>
            <div className="legend-items">
              <div className="legend-item">
                <span className="legend-swatch legend-swatch-ready" />
                <span>Можно пробовать записываться сейчас</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch legend-swatch-disabled" />
                <span>
                  На официальном сайте закрыто, но здесь можно попробовать
                  записаться без гарантии
                </span>
              </div>
            </div>
          </section>

          {loadingState === "loading" && (
            <div className="empty-state">Загрузка слотов…</div>
          )}

          {loadingState !== "loading" && sections.length === 0 && (
            <div className="empty-state">
              Под выбранное количество мест сейчас ничего не найдено.
            </div>
          )}

          {sections.map((section) => (
            <section key={section.eventType} className="event-section">
              <h2 className="event-section-title">{section.title}</h2>
              {section.description ? (
                <div
                  className="event-section-description"
                  dangerouslySetInnerHTML={{ __html: section.description }}
                />
              ) : null}

              {section.dates.map((dateGroup) => (
                <div
                  key={`${section.eventType}:${dateGroup.date}`}
                  className="date-section"
                >
                  <div className="date-section-title">{dateGroup.label}</div>

                  {dateGroup.courts.map((courtGroup) => (
                    <div
                      key={`${dateGroup.date}:${courtGroup.courtId}`}
                      className="court-section"
                    >
                      <div className="court-section-title">
                        {courtGroup.courtTitle}
                      </div>

                      <div className="slots-grid">
                        {courtGroup.slots.map((slot) => (
                          <button
                            key={slot.key}
                            type="button"
                            className={`slot-card slot-card-${getSlotVisualStatus(slot)} ${selectedSlotKey === slot.key ? "slot-card-active" : ""}`}
                            onClick={() => setSelectedSlotKey(slot.key)}
                          >
                            <span className="slot-time">{slot.time}</span>
                            <span className="slot-duration">
                              {slot.duration_minutes} мин
                            </span>
                            <span className="slot-tickets">
                              мест: {slot.available_tickets}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>

        <aside className="booking-column">
          <section className="booking-card">
            <h2>Выбранное время</h2>

            {selectedSlot ? (
              <div className="selection-summary">
                <div>
                  <span>Формат</span>
                  <strong>{selectedSlot.event_title}</strong>
                </div>
                <div>
                  <span>Дата</span>
                  <strong>{formatDateHuman(selectedSlot.date)}</strong>
                </div>
                <div>
                  <span>Начало</span>
                  <strong>{selectedSlot.time}</strong>
                </div>
                <div>
                  <span>Длительность</span>
                  <strong>{selectedSlot.duration_minutes} мин</strong>
                </div>
                <div>
                  <span>Площадка</span>
                  <strong>{selectedSlot.venue_title}</strong>
                </div>
                <div>
                  <span>Корт</span>
                  <strong>{selectedSlot.court_title}</strong>
                </div>
                <div>
                  <span>Свободно мест</span>
                  <strong>{selectedSlot.available_tickets}</strong>
                </div>
                <div>
                  <span>Статус</span>
                  <strong>
                    {getSlotVisualStatus(selectedSlot) === "ready"
                      ? "Можно пробовать записываться"
                      : "На официальном сайте закрыто, но здесь можно попробовать без гарантии"}
                  </strong>
                </div>
              </div>
            ) : (
              <p className="placeholder-text">
                Нажмите на карточку времени. После этого можно будет перейти к
                записи.
              </p>
            )}
          </section>

          <section className="booking-card">
            <h2>Данные для записи</h2>
            <div className="form-grid">
              <label>
                <span>Сколько мест нужно</span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, maxTicketsAvailable)}
                  value={requestedTickets}
                  onChange={(event) =>
                    setRequestedTickets(
                      Math.min(
                        Math.max(1, Number(event.target.value) || 1),
                        Math.max(1, maxTicketsAvailable),
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>Имя</span>
                <input
                  name="first_name"
                  value={profile.first_name}
                  onChange={updateProfile}
                  placeholder="Например: Иван"
                />
              </label>
              <label>
                <span>Фамилия</span>
                <input
                  name="last_name"
                  value={profile.last_name}
                  onChange={updateProfile}
                  placeholder="Например: Иванов"
                />
              </label>
              <label>
                <span>Телефон</span>
                <input
                  name="phone"
                  value={profile.phone}
                  onChange={updateProfile}
                  placeholder="+79991234567"
                />
              </label>
              <label>
                <span>Email</span>
                <input
                  name="email"
                  value={profile.email}
                  onChange={updateProfile}
                  placeholder="name@example.com"
                />
              </label>
            </div>
          </section>

          <section className="booking-card">
            <h2>Как записаться</h2>
            <div className="action-stack">
              <button
                type="button"
                onClick={handleHold}
                disabled={!selectedSlot || loadingStep === "hold"}
              >
                {loadingStep === "hold"
                  ? "Готовим запись…"
                  : "1. Забронировать это время"}
              </button>

              <button
                type="button"
                onClick={handleSmsSend}
                disabled={
                  !sessionId ||
                  !holdId ||
                  smsRetryInSeconds > 0 ||
                  loadingStep === "smsSend"
                }
              >
                {loadingStep === "smsSend"
                  ? "Отправляем код…"
                  : smsRetryInSeconds > 0
                    ? `2. Повтор через ${smsRetryInSeconds} с`
                    : "2. Получить код по SMS"}
              </button>

              <label>
                <span>Код из SMS</span>
                <input
                  value={smsCode}
                  onChange={(event) => setSmsCode(event.target.value)}
                  placeholder="Введите код"
                />
              </label>

              <button
                type="button"
                onClick={handleSmsVerify}
                disabled={
                  !sessionId ||
                  !holdId ||
                  !smsCode.trim() ||
                  loadingStep === "smsVerify"
                }
              >
                {loadingStep === "smsVerify"
                  ? "Проверяем код…"
                  : "3. Подтвердить код"}
              </button>

              <button
                type="button"
                className="confirm-button"
                onClick={handleConfirm}
                disabled={!verified || loadingStep === "confirm"}
              >
                {loadingStep === "confirm"
                  ? "Завершаем запись…"
                  : "4. Завершить запись"}
              </button>
            </div>
          </section>

          <section className="booking-card">
            <h2>Служебная информация</h2>
            <div className="selection-summary">
              <div>
                <span>Код подтверждён</span>
                <strong>{verified ? "Да" : "Нет"}</strong>
              </div>
              <div>
                <span>Время удержания слота</span>
                <strong>
                  {expiresInSeconds !== null
                    ? formatRemaining(expiresInSeconds)
                    : "—"}
                </strong>
              </div>
              <div>
                <span>Мест до удержания</span>
                <strong>{availableBeforeHold ?? "—"}</strong>
              </div>
              <div>
                <span>Мест после удержания</span>
                <strong>{availableAfterHold ?? "—"}</strong>
              </div>
              <div>
                <span>Номер сессии</span>
                <strong>{sessionId || "—"}</strong>
              </div>
              <div>
                <span>Номер удержания</span>
                <strong>{holdId || "—"}</strong>
              </div>
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function ToastViewport({ toasts, onClose }) {
  return (
    <div className="toast-viewport">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <button
            type="button"
            className="toast-close"
            onClick={() => onClose(toast.id)}
          >
            ×
          </button>
          <div className="toast-title">
            {toast.title}
            {toast.code ? ` · HTTP ${toast.code}` : ""}
          </div>
          <div className="toast-message">{toast.message}</div>
        </div>
      ))}
    </div>
  );
}

function ConsentOverlay({ consent }) {
  if (consent.status === "accepted") {
    return null;
  }

  const isLoading = consent.status === "loading";
  const isDeclined = consent.messageMode === "declined";

  return (
    <div className="consent-overlay">
      <div className="consent-card">
        <div className="consent-badge">🔐 Согласие обязательно</div>
        <h2>
          {isLoading
            ? "Проверяем доступ…"
            : isDeclined
              ? "Без согласия продолжить нельзя"
              : "Перед началом нужно согласие"}
        </h2>
        <p className="consent-text">
          {isLoading
            ? "Пожалуйста, подождите несколько секунд."
            : isDeclined
              ? "Чтобы пользоваться сайтом и оформлять запись, нужно принять согласие на обработку персональных данных."
              : "Для работы сайта нужно принять согласие на обработку персональных данных. Сначала откройте документ, затем подтвердите согласие."}
        </p>
        {!isLoading && (
          <>
            <a
              className="consent-link"
              href={consentDocumentUrl}
              target="_blank"
              rel="noreferrer"
            >
              📄 Открыть документ
            </a>
            <div className="consent-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={consent.declineConsent}
                disabled={consent.busy}
              >
                Не согласен(-на)
              </button>
              <button
                type="button"
                onClick={consent.acceptConsent}
                disabled={consent.busy}
              >
                {consent.busy ? "Сохраняем…" : "Согласен(-на)"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
