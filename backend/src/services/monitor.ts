import {
  DEFAULT_NOTIFY_MODES,
  MAX_ALERT_DATE,
  MONITOR_INTERVAL_MS,
  SUPPORTED_MONITOR_EVENT_TYPES,
  VENUES,
} from "../config";
import {
  deactivateSubscription,
  getConsent,
  finishInstantBookingRequest,
  listActiveInstantBookingRequests,
  updateInstantBookingAwaitingCode,
  listActiveSubscriptions,
  updateSubscriptionDelivery,
} from "../db";
import { InstantBookingRequest, MonitorSlot, Subscription } from "../types";
import {
  addDaysYmd,
  buildSearchDates,
  formatDateHuman,
  formatDateTimeHuman,
  getCurrentMskContext,
} from "../utils/date";
import { buildHash } from "../utils/hash";
import { getEventTypeLabel } from "../utils/domain";
import {
  createBookingSession,
  holdBookingSlot,
  fetchAvailabilityForMonitor,
  fetchDateOptionsForMonitor,
  mergeSlots,
  normalizeAvailabilitySlots,
  normalizeDateOptionSlots,
  sendBookingSms,
} from "./outdoor";
import { sendTelegramMessage } from "./telegram";

let monitorLoopStarted = false;
let monitorInProgress = false;

function normalizeNotifyModes(modes: readonly string[]): string[] {
  return Array.from(new Set(["ready", ...modes.map(String)]));
}

function buildMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: "Меню", callback_data: "menu_new|home" }]],
  };
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatJsonCodeBlock(payload: unknown): string {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) || "null";
  return `\`\`\`\n${text}\n\`\`\``;
}

async function sendJsonTelegramMessage(chatId: string, title: string, payload: unknown): Promise<void> {
  await sendTelegramMessage(chatId, `${title}\n${formatJsonCodeBlock(payload)}`, null, {
    parseMode: null,
  });
}

function matchesSubscription(
  slot: MonitorSlot,
  subscription: Subscription,
): boolean {
  if (!subscription.venues.includes(String(slot.venue_id))) {
    return false;
  }

  if (!subscription.event_types.includes(String(slot.event_type))) {
    return false;
  }

  if (!subscription.durations.includes(Number(slot.duration_minutes))) {
    return false;
  }

  if (
    subscription.start_times.length &&
    !subscription.start_times.includes(String(slot.starts_at).slice(11, 16))
  ) {
    return false;
  }

  if (
    subscription.date_filter &&
    subscription.date_filter !== slot.event_date
  ) {
    return false;
  }

  if (
    (Number(slot.raw_available_tickets) || 0) <
    (Number(subscription.min_raw_tickets) || 1)
  ) {
    return false;
  }

  const modes = new Set(
    normalizeNotifyModes(
      subscription.notify_modes.length
        ? subscription.notify_modes
        : DEFAULT_NOTIFY_MODES,
    ),
  );
  if (
    modes.has("disabled_visible") &&
    slot.booking_open === true &&
    slot.enabled === false
  ) {
    return true;
  }
  if (
    modes.has("ready") &&
    slot.booking_open === true &&
    slot.enabled === true
  ) {
    return true;
  }

  return false;
}

function renderSlotLine(slot: MonitorSlot, ticketsCount: number): string {
  return [
    `🕒 ${escapeHtml(formatDateTimeHuman(slot.starts_at))}`,
    `${escapeHtml(getEventTypeLabel(slot.event_type))} — ${slot.duration_minutes} мин`,
    `📍 ${escapeHtml(slot.venue_title)}, ${escapeHtml(slot.court_title)}`,
    `🎟 Доступно мест: ${ticketsCount}`,
  ].join(" | ");
}

function isDisabledVisibleSlot(slot: MonitorSlot): boolean {
  return slot.booking_open === true && slot.enabled === false;
}

function isReadySlot(slot: MonitorSlot): boolean {
  return slot.booking_open === true && slot.enabled === true;
}

function matchesInstantBookingRequest(slot: MonitorSlot, request: InstantBookingRequest): boolean {
  return (
    String(slot.venue_id) === String(request.venue_id) &&
    String(slot.event_type) === String(request.event_type) &&
    String(slot.event_date) === String(request.event_date) &&
    String(slot.starts_at).slice(11, 16) === String(request.start_time) &&
    Number(slot.duration_minutes) === Number(request.duration_minutes) &&
    slot.booking_open === true &&
    Number(slot.raw_available_tickets || slot.available_tickets || 0) >= Number(request.tickets_count || 1)
  );
}

function renderSection(
  title: string,
  slots: MonitorSlot[],
  ticketsSelector: (slot: MonitorSlot) => number,
): string {
  if (!slots.length) {
    return "";
  }

  return [
    `<b>${escapeHtml(title)}</b>`,
    ...slots.map((slot) => `• ${renderSlotLine(slot, ticketsSelector(slot))}`),
  ].join("\n");
}

function buildAlertHeader(
  subscription: Subscription,
  slots: MonitorSlot[],
): string {
  const venueText =
    Array.from(new Set(slots.map((slot) => slot.venue_title))).join(", ") ||
    subscription.venues.join(", ");
  const dateText = subscription.date_filter
    ? formatDateHuman(subscription.date_filter)
    : "несколько дат";
  return `<b>🔔 Подписка №${subscription.id}</b>\n📍 ${escapeHtml(venueText)}\n📅 ${escapeHtml(dateText)}`;
}

function renderAlertText(
  subscription: Subscription,
  slots: MonitorSlot[],
): string {
  const notifyModes = new Set(normalizeNotifyModes(subscription.notify_modes));
  const sections: string[] = [buildAlertHeader(subscription, slots)];

  if (notifyModes.has("disabled_visible")) {
    const disabledSlots = slots.filter(isDisabledVisibleSlot);
    if (disabledSlots.length) {
      sections.push(
        "",
        renderSection(
          "👀 Слоты, которые уже видны на официальном сайте, но там запись пока закрыта:",
          disabledSlots,
          (slot) =>
            Number(slot.available_tickets) ||
            Number(slot.raw_available_tickets) ||
            0,
        ),
      );
    }
  }

  const readySlots = slots.filter(isReadySlot);
  if (readySlots.length) {
    sections.push(
      "",
      renderSection(
        "✅ Уже можно записываться:",
        readySlots,
        (slot) =>
          Number(slot.available_tickets) ||
          Number(slot.raw_available_tickets) ||
          0,
      ),
    );
  }

  sections.push(
    "",
    '🔗 <a href="https://aeroserg.github.io/mos-sport/">Помощник записи</a> — это отдельная страница для записи. Она может быть полезна, когда слот уже есть на официальном сайте, но кнопка записи там ещё заблокирована и слот горит серым цветом. В этот момент через наш сервис можно попробовать записаться, но без гарантии результата.',
    '🔗 <a href="https://outdoor.sport.mos.ru/#venues-events">Официальный сайт Mos Sport</a> — когда на сайте уже можно нажать кнопку записи.',
  );

  return sections.join("\n");
}

async function expireFinishedSubscriptions(): Promise<void> {
  const subscriptions = listActiveSubscriptions();
  const current = getCurrentMskContext();

  for (const subscription of subscriptions) {
    if (!subscription.date_filter) {
      continue;
    }

    if (
      subscription.date_filter < current.date ||
      (subscription.date_filter === current.date && current.hour >= 22)
    ) {
      deactivateSubscription(subscription.id, "date_finished");
      if (getConsent("telegram", subscription.chat_id)?.accepted) {
        await sendTelegramMessage(
          subscription.chat_id,
          `Подписка #${subscription.id} на ${formatDateHuman(subscription.date_filter)} отключена: день закончился.`,
          buildMenuKeyboard(),
        );
      }
    }
  }
}

async function expireAwaitingCodeRequests(): Promise<void> {
  const requests = listActiveInstantBookingRequests().filter(
    (request) => request.status === "awaiting_code",
  );
  const now = Date.now();

  for (const request of requests) {
    if (!request.expires_at) {
      continue;
    }

    if (new Date(request.expires_at).getTime() > now) {
      continue;
    }

    finishInstantBookingRequest(request.id, "expired");
    if (request.alert_subscription_id) {
      deactivateSubscription(
        request.alert_subscription_id,
        "instant_booking_expired",
      );
    }
    await sendTelegramMessage(
      request.chat_id,
      "Мы не получили код подтверждения до окончания сессии, поэтому не смогли зарегистрировать вас на игру :(",
      buildMenuKeyboard(),
    );
  }
}

async function processInstantBookingQueue(allSlots: MonitorSlot[]): Promise<void> {
  const queueRequests = listActiveInstantBookingRequests()
    .filter((request) => request.status === "queued")
    .filter((request) => Boolean(getConsent("telegram", request.chat_id)?.accepted));

  const usersAwaitingCode = new Set(
    listActiveInstantBookingRequests()
      .filter((request) => request.status === "awaiting_code")
      .map((request) => request.chat_id),
  );

  const groupedSlots = new Map<string, { slots: MonitorSlot[]; requests: InstantBookingRequest[] }>();

  for (const request of queueRequests) {
    if (usersAwaitingCode.has(request.chat_id)) {
      continue;
    }

    const matchedSlots = allSlots
      .filter((candidate) => matchesInstantBookingRequest(candidate, request))
      .sort((left, right) => {
        const enabledDiff = Number(Boolean(right.enabled)) - Number(Boolean(left.enabled));
        if (enabledDiff !== 0) {
          return enabledDiff;
        }

        const ticketsDiff =
          Number(right.raw_available_tickets || right.available_tickets || 0) -
          Number(left.raw_available_tickets || left.available_tickets || 0);
        if (ticketsDiff !== 0) {
          return ticketsDiff;
        }

        return String(left.court_title).localeCompare(String(right.court_title), "ru");
      });
    if (!matchedSlots.length) {
      continue;
    }

    const key = [
      request.venue_id,
      request.event_type,
      request.event_date,
      request.start_time,
      request.duration_minutes,
    ].join("|");

    const current = groupedSlots.get(key);
    if (!current) {
      groupedSlots.set(key, {
        slots: matchedSlots,
        requests: [request],
      });
      continue;
    }

    current.slots = current.slots.length ? current.slots : matchedSlots;
    current.requests.push(request);
  }

  for (const { slots, requests } of groupedSlots.values()) {
    const remainingTicketsBySlot = new Map(
      slots.map((slot) => [
        [
          slot.venue_id,
          slot.court_id,
          slot.event_type,
          slot.event_id,
          slot.starts_at,
          slot.duration_minutes,
        ].join("|"),
        Number(slot.raw_available_tickets || slot.available_tickets || 0),
      ]),
    );

    for (const request of requests.sort((left, right) => left.created_at.localeCompare(right.created_at))) {
      const candidateSlots = slots.filter((slot) => {
        const slotKey = [
          slot.venue_id,
          slot.court_id,
          slot.event_type,
          slot.event_id,
          slot.starts_at,
          slot.duration_minutes,
        ].join("|");
        return (remainingTicketsBySlot.get(slotKey) || 0) >= Number(request.tickets_count);
      });
      if (!candidateSlots.length) {
        continue;
      }

      for (const slot of candidateSlots) {
        const slotKey = [
          slot.venue_id,
          slot.court_id,
          slot.event_type,
          slot.event_id,
          slot.starts_at,
          slot.duration_minutes,
        ].join("|");

        const sessionResult = await createBookingSession({
          event_type: request.event_type,
          venue_id: Number(request.venue_id),
          court_id: Number(slot.court_id),
          date: request.event_date,
        });

        if (sessionResult.status >= 400 || !sessionResult.isJson) {
          finishInstantBookingRequest(request.id, "failed", JSON.stringify(sessionResult.body));
          if (request.alert_subscription_id) {
            deactivateSubscription(
              request.alert_subscription_id,
              "instant_booking_failed",
            );
          }
          await sendJsonTelegramMessage(
            request.chat_id,
            "К сожалению, мы не смогли создать сессию для beta-заявки. Вот ответ сервиса:",
            sessionResult.body,
          );
          break;
        }

        const sessionPayload = sessionResult.body as {
          session_id?: string;
          expires_at?: string;
        };
        const sessionId = String(sessionPayload.session_id || "");

        const holdResult = await holdBookingSlot(sessionId, {
          event_id: Number(slot.event_id),
          starts_at: slot.starts_at,
          ends_at: slot.ends_at,
          duration_minutes: Number(slot.duration_minutes),
          tickets_count: Number(request.tickets_count),
        });

        if (holdResult.status >= 400 || !holdResult.isJson) {
          const holdMessage =
            typeof holdResult.body === "object" &&
            holdResult.body &&
            Array.isArray((holdResult.body as { errors?: Array<{ message?: string }> }).errors)
              ? String((holdResult.body as { errors?: Array<{ message?: string }> }).errors?.[0]?.message || "")
              : "";

          if (
            holdMessage.includes("Not enough available tickets") ||
            holdMessage.includes("Registration session expired") ||
            holdMessage.includes("Registration session is not active")
          ) {
            continue;
          }

          finishInstantBookingRequest(request.id, "failed", JSON.stringify(holdResult.body));
          if (request.alert_subscription_id) {
            deactivateSubscription(
              request.alert_subscription_id,
              "instant_booking_failed",
            );
          }
          await sendJsonTelegramMessage(
            request.chat_id,
            "К сожалению, мы не смогли удержать слот для beta-заявки. Вот ответ сервиса:",
            holdResult.body,
          );
          break;
        }

        const holdPayload = holdResult.body as {
          hold_id?: string;
          session_id?: string;
          expires_at?: string;
        };
        const holdId = String(holdPayload.hold_id || "");

        const smsResult = await sendBookingSms({
          session_id: String(holdPayload.session_id || sessionId),
          hold_id: holdId,
          phone: request.phone,
        });

        if (smsResult.status >= 400) {
          finishInstantBookingRequest(request.id, "failed", JSON.stringify(smsResult.body));
          if (request.alert_subscription_id) {
            deactivateSubscription(
              request.alert_subscription_id,
              "instant_booking_failed",
            );
          }
          await sendJsonTelegramMessage(
            request.chat_id,
            "К сожалению, мы удержали слот, но не смогли отправить SMS-код. Вот ответ сервиса:",
            smsResult.body,
          );
          break;
        }

        updateInstantBookingAwaitingCode({
          id: request.id,
          session_id: String(holdPayload.session_id || sessionId),
          hold_id: holdId,
          event_id: Number(slot.event_id),
          starts_at: slot.starts_at,
          ends_at: slot.ends_at,
          expires_at: String(holdPayload.expires_at || sessionPayload.expires_at || ""),
        });

        await sendTelegramMessage(
          request.chat_id,
          [
            "⚡ Мы пытаемся записать вас на падел.",
            "",
            "<b>Параметры записи:</b>",
            `• 📍 Площадка: ${slot.venue_title}, ${slot.court_title}`,
            `• 🎾 Формат: ${escapeHtml(getEventTypeLabel(slot.event_type))}`,
            `• 🕒 Время: ${formatDateTimeHuman(slot.starts_at)} · ${slot.duration_minutes} мин`,
            `• 🎟 Мест: ${request.tickets_count}`,
            `• 👤 Имя: ${escapeHtml(request.first_name)}`,
            `• 👤 Фамилия: ${escapeHtml(request.last_name)}`,
            `• ☎️ Телефон: ${escapeHtml(request.phone)}`,
            `• ✉️ Email: ${escapeHtml(request.email)}`,
            "",
            "Следующим сообщением пришлите код подтверждения из SMS.",
            "",
            "⚠️ <b>Важно:</b> официальная запись требует код из SMS. Мы не можем пропустить этот шаг или подтвердить запись без вашего кода.",
            "",
            "⚠️ <b>Важно:</b> мы передадим код только в официальное API Mos Sport / mos.ru и больше никуда.",
            "",
            "⚠️ <b>Важно:</b> если в течение двух минут вы не пришлёте код в бот, удержание слота сгорит и место снова станет доступно для ручной записи.",
            "",
            "🙂 Напомним: это студенческий некоммерческий проект. Мы не просим оплату, не продаём услуги и не делаем ничего подобного — всё работает бесплатно.",
            "",
            "Если вы не доверяете передавать код через бота, лучше воспользуйтесь сервисом уведомлений и записывайтесь вручную на официальном сайте.",
          ].join("\n"),
          buildMenuKeyboard(),
        );

        remainingTicketsBySlot.set(
          slotKey,
          Math.max(0, (remainingTicketsBySlot.get(slotKey) || 0) - Number(request.tickets_count)),
        );
        usersAwaitingCode.add(request.chat_id);
        break;
      }
    }
  }
}

export async function runMonitorTick(): Promise<void> {
  if (monitorInProgress) {
    return;
  }

  monitorInProgress = true;

  try {
    await expireFinishedSubscriptions();
    await expireAwaitingCodeRequests();

    const subscriptions = listActiveSubscriptions();
    const queueRequests = listActiveInstantBookingRequests().filter((request) =>
      Boolean(getConsent("telegram", request.chat_id)?.accepted),
    );
    if (!subscriptions.length && !queueRequests.length) {
      return;
    }

    const consentedSubscriptions = subscriptions.filter((subscription) =>
      Boolean(getConsent("telegram", subscription.chat_id)?.accepted),
    );
    if (!consentedSubscriptions.length && !queueRequests.length) {
      return;
    }

    const venueIds = Array.from(
      new Set([
        ...consentedSubscriptions.flatMap((item) => item.venues.map(String)),
        ...queueRequests.map((item) => String(item.venue_id)),
      ]),
    );
    const eventTypes = Array.from(
      new Set(
        [...consentedSubscriptions.flatMap((item) => item.event_types.map(String)), ...queueRequests.map((item) => String(item.event_type))]
          .filter((value) =>
            SUPPORTED_MONITOR_EVENT_TYPES.includes(
              value as "free_play" | "masterclass",
            ),
          ),
      ),
    );

    const dateOptionsResults = await Promise.all(
      venueIds.flatMap((venueId) =>
        eventTypes.map((eventType) =>
          fetchDateOptionsForMonitor(venueId, eventType),
        ),
      ),
    );

    const serverNow =
      dateOptionsResults.find(
        (item) => item.status < 400 && item.body?.server_now,
      )?.body?.server_now || new Date().toISOString();
    const openWindowDates = new Set(buildSearchDates(3, serverNow));

    const dateOptionSlots = dateOptionsResults
      .filter((item) => item.status < 400)
      .flatMap((item) => normalizeDateOptionSlots(item.body));

    const availabilityQueries = Array.from(
      new Set(
        [
          ...consentedSubscriptions.flatMap((subscription) =>
            subscription.venues.flatMap((venueId) =>
              subscription.event_types.flatMap((eventType) =>
                VENUES[String(venueId) as keyof typeof VENUES].courts.map(
                  (courtId) =>
                    [venueId, courtId, eventType, subscription.date_filter].join(
                      "|",
                    ),
                ),
              ),
            ),
          ),
          ...queueRequests.map((request) =>
            [
              request.venue_id,
              request.court_id,
              request.event_type,
              request.event_date,
            ].join("|"),
          ),
        ],
      ),
    ).map((key) => {
      const [venueId, courtId, eventType, date] = key.split("|");
      return { venueId, courtId, eventType, date };
    });

    const availabilityResults = await Promise.all(
      availabilityQueries.map((query) =>
        fetchAvailabilityForMonitor(
          query.venueId,
          query.courtId,
          query.eventType,
          query.date,
        ),
      ),
    );

    const availabilitySlots = availabilityResults
      .filter((item) => item.status < 400)
      .flatMap((item) =>
        normalizeAvailabilitySlots(item.body, {
          venue_id: item.venue_id,
          court_id: item.court_id,
          event_type: item.event_type,
          date: item.date,
        }),
      );

    const allSlots = mergeSlots([
      ...dateOptionSlots,
      ...availabilitySlots,
    ]).filter((slot) => slot.event_date && slot.event_date <= MAX_ALERT_DATE);

    await processInstantBookingQueue(allSlots);

    for (const subscription of consentedSubscriptions) {
      const matchingSlots = allSlots.filter((slot) => {
        if (!matchesSubscription(slot, subscription)) {
          return false;
        }

        if (!subscription.notify_modes.includes("disabled_visible")) {
          if (
            slot.event_date > addDaysYmd(getCurrentMskContext().date, 2) &&
            !openWindowDates.has(slot.event_date) &&
            slot.booking_open !== true
          ) {
            return false;
          }
        }

        return true;
      });

      if (!matchingSlots.length) {
        continue;
      }

      const text = renderAlertText(subscription, matchingSlots);
      const fingerprint = buildHash(text);
      if (subscription.last_sent_fingerprint === fingerprint) {
        continue;
      }

      await sendTelegramMessage(
        subscription.chat_id,
        text,
        buildMenuKeyboard(),
      );
      updateSubscriptionDelivery(subscription.id, fingerprint, text);
    }
  } catch (error) {
    console.error("Monitor tick failed:", error);
  } finally {
    monitorInProgress = false;
  }
}

export async function startMonitorLoop(): Promise<void> {
  if (monitorLoopStarted) {
    return;
  }

  monitorLoopStarted = true;
  await runMonitorTick();
  setInterval(() => {
    void runMonitorTick();
  }, MONITOR_INTERVAL_MS);
}
