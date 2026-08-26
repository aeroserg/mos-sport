import {
  CONSENT_DOCUMENT_URL,
  DEFAULT_NOTIFY_MODES,
  DURATION_OPTIONS,
  SUPPORTED_MONITOR_EVENT_TYPES,
  TELEGRAM_API_BASE,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  VENUES,
} from "../config";
import {
  clearState,
  countQueueForSlot,
  createInstantBookingRequest,
  createSubscription,
  deactivateSubscription,
  deactivateSubscriptionForChat,
  finishInstantBookingRequest,
  getAwaitingCodeRequestByChat,
  getConsent,
  getKv,
  getState,
  listInstantBookingRequestsByChat,
  listSubscriptionsByChat,
  saveUser,
  setConsentAccepted,
  setKv,
  setState,
} from "../db";
import {
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  WizardState,
} from "../types";
import {
  answerCallbackQuery,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
} from "./telegram";
import {
  formatDateHuman,
  getCurrentMskContext,
  parseFlexibleDateInput,
} from "../utils/date";
import { getEventTypeLabel, getVenueLabel } from "../utils/domain";
import { confirmBooking, verifyBookingSms } from "./outdoor";

let telegramLoopStarted = false;

function hasTelegramConsent(chatId: string): boolean {
  return Boolean(getConsent("telegram", chatId)?.accepted);
}

function normalizeNotifyModes(modes: readonly string[]): string[] {
  return Array.from(new Set(["ready", ...modes.map(String)]));
}

function isAlertMessageText(text?: string): boolean {
  return String(text || "").includes("Найдены слоты по подписке");
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function button(
  text: string,
  data: string,
): { text: string; callback_data: string } {
  return { text, callback_data: data };
}

function withCheckmark(selected: boolean, text: string): string {
  return selected ? `✅ ${text}` : text;
}

function listActiveInstantRequestsByChat(chatId: string) {
  return listInstantBookingRequestsByChat(chatId).filter((request) =>
    ["queued", "awaiting_code"].includes(request.status),
  );
}

function createInitialWizardState(messageId?: number | null): WizardState {
  return {
    flow: "subscription",
    step: "venues",
    history: [],
    message_id: messageId || null,
    data: {
      venues: [],
      event_types: [],
      durations: [],
      start_times: [],
      min_raw_tickets: 1,
      date_filters: [],
      notify_modes: normalizeNotifyModes([...DEFAULT_NOTIFY_MODES]),
    },
  };
}

function createInitialInstantWizardState(
  messageId?: number | null,
): WizardState {
  return {
    flow: "instant_booking",
    step: "instant_intro",
    history: [],
    message_id: messageId || null,
    data: {
      venues: [],
      event_types: [],
      durations: [],
      start_times: [],
      min_raw_tickets: 1,
      date_filters: [],
      notify_modes: normalizeNotifyModes([...DEFAULT_NOTIFY_MODES]),
      instant_notify_on_match: false,
      instant_notify_gray: false,
    },
  };
}

function normalizePhone(value: string): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^9\d{9}$/.test(digits)) {
    return `+7${digits}`;
  }
  if (/^7\d{10}$/.test(digits)) {
    return `+${digits}`;
  }
  if (/^8\d{10}$/.test(digits)) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isValidCode(value: string): boolean {
  return /^\d{4,6}$/.test(String(value || "").trim());
}

function formatJsonCodeBlock(payload: unknown): string {
  const text =
    typeof payload === "string"
      ? payload
      : JSON.stringify(payload, null, 2) || "null";
  return `\`\`\`\n${text}\n\`\`\``;
}

async function sendJsonErrorMessage(
  chatId: string,
  title: string,
  payload: unknown,
): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `${title}\n${formatJsonCodeBlock(payload)}`,
    null,
    { parseMode: null },
  );
}

function popHistory(state: WizardState): WizardState {
  const history = [...state.history];
  const previous = history.pop();
  return {
    ...state,
    history,
    step: previous || "venues",
  };
}

function subscriptionSummary(subscriptionData: {
  venues: string[];
  event_types: string[];
  durations: number[];
  start_times?: string[];
  min_raw_tickets: number;
  date_filter?: string;
  date_filters?: string[];
  notify_modes: string[];
}): string {
  const venuesText = subscriptionData.venues.map(getVenueLabel).join(", ");
  const eventTypesText = subscriptionData.event_types
    .map(getEventTypeLabel)
    .join(", ");
  const durationsText = subscriptionData.durations
    .map((item) => `${item} мин`)
    .join(", ");
  const timesText = subscriptionData.start_times?.length
    ? subscriptionData.start_times.join(", ")
    : "";
  const notifyModesText = formatNotifyModes(subscriptionData.notify_modes);
  const dates = subscriptionData.date_filters?.length
    ? subscriptionData.date_filters
    : subscriptionData.date_filter
      ? [subscriptionData.date_filter]
      : [];
  const datesText = dates.length ? dates.map(formatDateHuman).join(", ") : "—";

  return [
    `<b>📍 Площадки:</b> ${escapeHtml(venuesText || "—")}`,
    `<b>🎾 Форматы:</b> ${escapeHtml(eventTypesText || "—")}`,
    `<b>⏱ Длительность:</b> ${escapeHtml(durationsText || "—")}`,
    timesText ? `<b>🕒 Время:</b> ${escapeHtml(timesText)}` : "",
    `<b>🎟 Минимум мест:</b> ${subscriptionData.min_raw_tickets || "—"}`,
    `<b>📅 Даты:</b> ${escapeHtml(datesText)}`,
    `<b>🔔 Когда писать:</b>\n• ${notifyModesText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNotifyModes(modes: string[]): string {
  const normalized = new Set(normalizeNotifyModes(modes));
  const labels: string[] = [];

  if (normalized.has("ready")) {
    labels.push("всегда, когда запись уже реально доступна на сайте");
  }
  if (normalized.has("disabled_visible")) {
    labels.push(
      "дополнительно, когда слот уже виден на сайте, но кнопка записи там ещё неактивна; через наш сервис в этот момент можно попробовать записаться, но без гарантии",
    );
  }

  return labels.map((item) => escapeHtml(item)).join("\n• ");
}

function buildMainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("🔔 Подписаться на уведомления", "menu|subscribe")],
      [button("🔔 Мои подписки на уведомления", "menu|list")],
      [button("🔔 Отключить подписку на уведомления", "menu|unsubscribe")],
      [button("⚡ Мгновенная бронь (beta)", "menu|instant")],
      [button("⚡ Мои мгновенные брони (beta)", "menu|instant_list")],
      [button("⚡ Отменить мгновенную бронь (beta)", "menu|instant_cancel")],
    ],
  };
}

function buildConsentKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "📄 Открыть документ", url: CONSENT_DOCUMENT_URL }],
      [
        button("Не согласен(-на)", "consent|decline"),
        button("Согласен(-на)", "consent|accept"),
      ],
    ],
  };
}

function buildConsentText(mode: "initial" | "declined"): string {
  if (mode === "declined") {
    return [
      "<b>⚠️ Без согласия продолжить нельзя</b>",
      "",
      "Чтобы бот мог работать и присылать уведомления, нужно принять <b>согласие на обработку персональных данных</b>.",
      "",
      `Сначала откройте документ: <a href="${escapeHtml(CONSENT_DOCUMENT_URL)}">согласие на обработку персональных данных</a>`,
      "",
      "После этого нажмите <b>«Согласен(-на)»</b>.",
    ].join("\n");
  }

  return [
    "<b>🔐 Сначала нужно согласие</b>",
    "",
    "Для работы бота нужно принять <b>согласие на обработку персональных данных</b>.",
    "",
    "Прочитайте документ и подтвердите согласие, чтобы продолжить.",
    "",
    `Документ: <a href="${escapeHtml(CONSENT_DOCUMENT_URL)}">согласие на обработку персональных данных</a>`,
  ].join("\n");
}

function buildStepKeyboard(state: WizardState): InlineKeyboardMarkup {
  const data = state.data;

  if (state.flow === "instant_booking") {
    if (state.step === "instant_intro") {
      return {
        inline_keyboard: [
          [button("Продолжить", "instant|intro|continue")],
          [button("❌ Отмена", "instant|cancel")],
        ],
      };
    }

    if (state.step === "instant_venue") {
      return {
        inline_keyboard: [
          ...Object.values(VENUES).map((venue) => [
            button(
              withCheckmark(
                String(data.instant_venue || "") === String(venue.id),
                venue.title,
              ),
              `instant|venue|set|${venue.id}`,
            ),
          ]),
          [button("✅ Дальше", "instant|venue|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_event_type") {
      return {
        inline_keyboard: [
          ...SUPPORTED_MONITOR_EVENT_TYPES.map((eventType) => [
            button(
              withCheckmark(
                String(data.instant_event_type || "") === String(eventType),
                getEventTypeLabel(eventType),
              ),
              `instant|event_type|set|${eventType}`,
            ),
          ]),
          [button("✅ Дальше", "instant|event_type|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_duration") {
      return {
        inline_keyboard: [
          ...DURATION_OPTIONS.map((duration) => [
            button(
              withCheckmark(
                Number(data.instant_duration || 0) === Number(duration),
                `${duration} минут`,
              ),
              `instant|duration|set|${duration}`,
            ),
          ]),
          [button("✅ Дальше", "instant|duration|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_tickets") {
      return {
        inline_keyboard: [
          [1, 2].map((value) =>
            button(
              withCheckmark(
                Number(data.instant_tickets || 0) === value,
                String(value),
              ),
              `instant|tickets|set|${value}`,
            ),
          ),
          [3, 4].map((value) =>
            button(
              withCheckmark(
                Number(data.instant_tickets || 0) === value,
                String(value),
              ),
              `instant|tickets|set|${value}`,
            ),
          ),
          [button("✅ Дальше", "instant|tickets|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (
      [
        "instant_date",
        "instant_time",
        "instant_first_name",
        "instant_last_name",
        "instant_phone",
        "instant_email",
      ].includes(state.step)
    ) {
      return {
        inline_keyboard: [
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_alerts") {
      return {
        inline_keyboard: [
          [
            button(
              withCheckmark(
                Boolean(data.instant_notify_on_match),
                "Да, добавить уведомления",
              ),
              "instant|alerts|set|yes",
            ),
          ],
          [
            button(
              withCheckmark(
                !data.instant_notify_on_match,
                "Нет, без уведомлений",
              ),
              "instant|alerts|set|no",
            ),
          ],
          [button("✅ Дальше", "instant|alerts|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_alerts_gray") {
      return {
        inline_keyboard: [
          [
            button(
              withCheckmark(
                Boolean(data.instant_notify_gray),
                "Да, писать и про серые слоты",
              ),
              "instant|alerts_gray|set|yes",
            ),
          ],
          [
            button(
              withCheckmark(
                !data.instant_notify_gray,
                "Нет, только когда уже открыто",
              ),
              "instant|alerts_gray|set|no",
            ),
          ],
          [button("✅ Дальше", "instant|alerts_gray|done")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }

    if (state.step === "instant_queue_confirm") {
      return {
        inline_keyboard: [
          [button("Продолжить", "instant|queue|create")],
          [
            button("⬅️ Назад", "instant|back"),
            button("❌ Отмена", "instant|cancel"),
          ],
        ],
      };
    }
  }

  if (state.step === "venues") {
    const selected = new Set(data.venues.map(String));
    const allVenueIds = Object.keys(VENUES);
    const rows = Object.values(VENUES).map((venue) => [
      button(
        withCheckmark(selected.has(String(venue.id)), venue.title),
        `sub|venues|toggle|${venue.id}`,
      ),
    ]);

    rows.push([
      button(
        withCheckmark(selected.size === allVenueIds.length, "Все площадки"),
        "sub|venues|all",
      ),
    ]);
    if (selected.size > 0) {
      rows.push([button("✅ Дальше", "sub|venues|done")]);
    }
    rows.push([button("❌ Отмена", "sub|cancel")]);
    return { inline_keyboard: rows };
  }

  if (state.step === "event_types") {
    const selected = new Set(data.event_types.map(String));
    const allEventTypes = [...SUPPORTED_MONITOR_EVENT_TYPES];
    const rows = allEventTypes.map((eventType) => [
      button(
        withCheckmark(
          selected.has(String(eventType)),
          getEventTypeLabel(eventType),
        ),
        `sub|event_types|toggle|${eventType}`,
      ),
    ]);

    rows.push([
      button(
        withCheckmark(selected.size === allEventTypes.length, "Все форматы"),
        "sub|event_types|all",
      ),
    ]);
    if (selected.size > 0) {
      rows.push([button("✅ Дальше", "sub|event_types|done")]);
    }
    rows.push([
      button("⬅️ Назад", "sub|back"),
      button("❌ Отмена", "sub|cancel"),
    ]);
    return { inline_keyboard: rows };
  }

  if (state.step === "durations") {
    const selected = new Set(data.durations.map(Number));
    const allDurations = [...DURATION_OPTIONS];
    const rows = allDurations.map((duration) => [
      button(
        withCheckmark(selected.has(Number(duration)), `${duration} минут`),
        `sub|durations|toggle|${duration}`,
      ),
    ]);

    rows.push([
      button(
        withCheckmark(
          selected.size === allDurations.length,
          "Все длительности",
        ),
        "sub|durations|all",
      ),
    ]);
    if (selected.size > 0) {
      rows.push([button("✅ Дальше", "sub|durations|done")]);
    }
    rows.push([
      button("⬅️ Назад", "sub|back"),
      button("❌ Отмена", "sub|cancel"),
    ]);
    return { inline_keyboard: rows };
  }

  if (state.step === "tickets") {
    return {
      inline_keyboard: [
        [1, 2].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [3, 4].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [button("⬅️ Назад", "sub|back"), button("❌ Отмена", "sub|cancel")],
      ],
    };
  }

  if (state.step === "date_input") {
    return {
      inline_keyboard: [
        [button("⬅️ Назад", "sub|back"), button("❌ Отмена", "sub|cancel")],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        button(
          withCheckmark(
            normalizeNotifyModes(data.notify_modes).includes(
              "disabled_visible",
            ),
            "👀 Написать раньше",
          ),
          "sub|notify|toggle|disabled_visible",
        ),
      ],
      [button("Только когда можно записаться", "sub|notify|default")],
      [button("✅ Сохранить подписку", "sub|notify|done")],
      [button("⬅️ Назад", "sub|back"), button("❌ Отмена", "sub|cancel")],
    ],
  };
}

function buildStepText(state: WizardState): string {
  const data = state.data;
  const dateFilters = data.date_filters || [];

  if (state.flow === "instant_booking") {
    if (state.step === "instant_intro") {
      return [
        "<b>⚡ Мгновенная бронь (beta)</b>",
        "",
        "Это функция для попытки автоматической записи на нужный слот, как только он появится.",
        "",
        "⚠️ <b>Важно:</b> функция тестовая и может сработать не всегда. Она может и не записать вас.",
        "",
        "⚠️ <b>Важно:</b> мы не отправляем ваши данные никому, кроме официального API Mos Sport / mos.ru. Они используются только для попытки записи.",
        "",
        "⚠️ <b>Важно:</b> официальная запись всё равно требует код из SMS. Мы не можем пропустить этот шаг или подтвердить запись без вашего кода.",
        "",
        "⚠️ <b>Важно:</b> после отправки SMS у вас будет около двух минут, чтобы прислать код в бот. Если код не ввести в бот вовремя, удержание слота сгорит и место снова станет доступно для ручной записи.",
        "",
        "🙂 И ещё: это студенческий некоммерческий проект. Мы не просим деньги, не берём кредиты и вообще не занимаемся ничем подобным — сервис работает бесплатно.",
        "",
        'Если вы не доверяете передавать код через бота, лучше воспользуйтесь сервисом уведомлений и записывайтесь вручную на <a href="https://outdoor.sport.mos.ru/#venues-events">официальном сайте</a>.',
        "",
        "Как это работает:",
        "• вы заранее задаёте точные параметры слота и свои данные",
        "• мы смотрим оба корта выбранной площадки и берём любой, где есть нужное количество мест",
        "• если наш монитор видит подходящий слот, мы сразу пытаемся удержать его и отправить SMS-код",
        "• после этого бот попросит вас прислать код подтверждения",
        "",
        "Если вас это устраивает, нажмите <b>«Продолжить»</b>.",
      ].join("\n");
    }

    if (state.step === "instant_venue") {
      return "<b>Шаг 1 · Площадка</b>\nВыберите одну площадку для попытки мгновенной записи.";
    }

    if (state.step === "instant_event_type") {
      return "<b>Шаг 2 · Формат</b>\nВыберите один формат игры.";
    }

    if (state.step === "instant_duration") {
      return "<b>Шаг 3 · Длительность</b>\nВыберите одну длительность занятия.";
    }

    if (state.step === "instant_tickets") {
      return [
        "<b>Шаг 4 · Количество мест</b>",
        "Выберите, сколько мест нужно.",
        "",
        "Обычно реально появляются 1–4 места.",
        "",
        "⚠️ <b>Важно:</b> если вы выберете 4 места, а доступно будет только 3, мы вообще не начнём попытку записи.",
      ].join("\n");
    }

    if (state.step === "instant_date") {
      return [
        "<b>Шаг 5 · Дата</b>",
        "Отправьте одну дату сообщением.",
        "",
        "Подходят форматы: <code>27</code>, <code>27.06</code>, <code>2026-06-27</code>, <code>27 июня</code>.",
      ].join("\n");
    }

    if (state.step === "instant_time") {
      return [
        "<b>Шаг 6 · Время</b>",
        "Отправьте точное время начала в формате <code>ЧЧ:ММ</code>.",
        "Например: <code>19:00</code>",
        "",
        "Мы будем искать это время сразу на обоих кортах выбранной площадки.",
      ].join("\n");
    }

    if (state.step === "instant_alerts") {
      return [
        "<b>Шаг 7 · Дополнительные уведомления</b>",
        "Хотите дополнительно получать уведомления, когда этот слот появится?",
      ].join("\n");
    }

    if (state.step === "instant_alerts_gray") {
      return [
        "<b>Шаг 8 · Серые слоты</b>",
        "Писать ли вам и тогда, когда слот уже появился, но на официальном сайте кнопка записи ещё закрыта?",
        "",
        "Через наш сервис в этот момент можно только попробовать записаться, без гарантии.",
      ].join("\n");
    }

    if (state.step === "instant_first_name") {
      return "<b>Шаг 9 · Имя</b>\nОтправьте имя, на которое будет произведена запись.";
    }

    if (state.step === "instant_last_name") {
      return "<b>Шаг 10 · Фамилия</b>\nОтправьте фамилию, на которую будет произведена запись.";
    }

    if (state.step === "instant_phone") {
      return [
        "<b>Шаг 11 · Телефон</b>",
        "Отправьте российский номер телефона.",
        "",
        "⚠️ <b>Важно:</b> если номер неверный, Mos Sport не пришлёт SMS-код.",
      ].join("\n");
    }

    if (state.step === "instant_email") {
      return [
        "<b>Шаг 12 · Email</b>",
        "Отправьте email для записи.",
        "",
        "⚠️ <b>Важно:</b> если email будет неверный, письмо с QR-кодом не придет.",
      ].join("\n");
    }

    if (state.step === "instant_queue_confirm") {
      const currentQueueCount = countQueueForSlot({
        venue_id: String(data.instant_venue || ""),
        court_id: "",
        event_type: String(data.instant_event_type || ""),
        event_date: String(data.instant_date || ""),
        start_time: String(data.instant_time || ""),
        duration_minutes: Number(data.instant_duration || 0),
      });
      return [
        "<b>Проверьте заявку</b>",
        "",
        `<b>📍 Площадка:</b> ${escapeHtml(getVenueLabel(data.instant_venue || ""))}`,
        `<b>🎾 Формат:</b> ${escapeHtml(getEventTypeLabel(data.instant_event_type || ""))}`,
        `<b>⏱ Длительность:</b> ${escapeHtml(String(data.instant_duration || "—"))} мин`,
        `<b>🎟 Мест:</b> ${escapeHtml(String(data.instant_tickets || "—"))}`,
        `<b>📅 Дата:</b> ${escapeHtml(data.instant_date ? formatDateHuman(data.instant_date) : "—")}`,
        `<b>🕒 Время:</b> ${escapeHtml(data.instant_time || "—")}`,
        `<b>🎾 Корт:</b> любой подходящий на этой площадке`,
        "",
        `На такие же параметры сейчас претендует <b>${currentQueueCount}</b> ${currentQueueCount === 1 ? "человек" : "человек"}.`,
        `Мы поставим вас в очередь под номером <b>${currentQueueCount + 1}</b>.`,
        currentQueueCount > 0
          ? "Если после более ранних заявок останутся билеты, попробуем записать и вас."
          : "",
        "",
        "⚠️ <b>Важно:</b> если на момент попытки записи свободных мест будет меньше, чем вы указали, мы не начнём запись.",
        "",
        "<i>После нажатия «Продолжить» мы создадим beta-заявку на этот точный слот.</i>",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  if (state.step === "venues") {
    return [
      "<b>Шаг 1 из 6 · 📍 Площадки</b>",
      "Выберите, за какими площадками следить.",
      "",
      `<i>Сейчас выбрано:</i> ${escapeHtml(
        data.venues.length
          ? data.venues.map(getVenueLabel).join(", ")
          : "пока ничего",
      )}`,
    ].join("\n");
  }

  if (state.step === "event_types") {
    return [
      "<b>Шаг 2 из 6 · 🎾 Форматы</b>",
      "Выберите, на какие форматы записи подписаться.",
      "",
      `<i>Сейчас выбрано:</i> ${escapeHtml(
        data.event_types.length
          ? data.event_types.map(getEventTypeLabel).join(", ")
          : "пока ничего",
      )}`,
    ].join("\n");
  }

  if (state.step === "durations") {
    return [
      "<b>Шаг 3 из 6 · ⏱ Длительность</b>",
      "Выберите подходящую длительность игры.",
      "",
      `<i>Сейчас выбрано:</i> ${escapeHtml(
        data.durations.length
          ? data.durations.map((item) => `${item} мин`).join(", ")
          : "пока ничего",
      )}`,
    ].join("\n");
  }

  if (state.step === "tickets") {
    return [
      "<b>Шаг 4 из 6 · 🎟 Места</b>",
      "Выберите минимальное количество свободных мест, которое вам подходит.",
      "",
      "Обычно реально появляются 1–4 места.",
      "",
      "⚠️ Если выбрано 2 места, а появится только 1, уведомление не придёт.",
    ].join("\n");
  }

  if (state.step === "date_input") {
    return [
      "<b>Шаг 5 из 6 · 📅 Даты</b>",
      "Отправьте одну или несколько дат одним сообщением.",
      "",
      "Примеры:",
      "• <code>27</code> — только число; если такая дата уже прошла в этом месяце, возьмём следующий месяц",
      "• <code>27.06</code> — день и месяц",
      "• <code>27 июня</code> — дата с русским названием месяца",
      "• <code>27, 28</code> или <code>27, 28.06</code> — несколько дат через запятую, в любом понятном формате",
      "• <code>27-29</code> или <code>27.06-29.06</code> — период подряд, но не больше 3 дней",
      "",
      "⚠️ Диапазон можно указать только на 3 дня или меньше.",
    ].join("\n");
  }

  const currentDate = getCurrentMskContext().date;
  const isFutureBeyondOpenWindow = dateFilters.some(
    (date) => date > currentDate,
  );
  const warning = isFutureBeyondOpenWindow
    ? "⏰ Мы в любом случае напишем, когда запись на выбранные даты действительно откроется на сайте."
    : "✅ Мы напишем, как только запись на выбранные даты станет доступна на сайте.";

  return [
    "<b>Шаг 6 из 6 · 🔔 Уведомления</b>",
    warning,
    "",
    "По умолчанию я пишу только тогда, когда на сайте уже можно нажать кнопку записи.",
    "",
    "Если хотите, могу написать немного раньше — когда слот уже появился на сайте, но он ещё серый и на официальном сайте записаться на него пока нельзя.",
    "",
    'Это может быть полезно для записи через <a href="https://aeroserg.github.io/mos-sport/"><b>помощник записи</b></a>.',
    '<a href="https://aeroserg.github.io/mos-sport/">Помощник записи</a> — это отдельная страница, где можно попробовать записаться вручную. Она может помочь, когда на официальном сайте слот уже показывается, но кнопка записи там ещё заблокирована.',
    "Важно: в такой момент через наш сервис можно только <b>попробовать</b> записаться. Это не гарантирует, что запись действительно получится.",
    "",
    subscriptionSummary(data),
  ].join("\n");
}

async function renderConsentPrompt(
  chatId: string,
  options?: {
    messageId?: number | null;
    mode?: "initial" | "declined";
    forceNew?: boolean;
  },
): Promise<void> {
  const text = buildConsentText(options?.mode || "initial");
  const keyboard = buildConsentKeyboard();

  if (options?.messageId && !options?.forceNew) {
    await editTelegramMessage(chatId, options.messageId, text, keyboard);
    return;
  }

  await sendTelegramMessage(chatId, text, keyboard);
}

async function renderMenu(
  chatId: string,
  messageId?: number | null,
): Promise<void> {
  const text = [
    "<b>🎾 Уведомления о записи на бесплатный падел в Москве</b>",
    "",
    "Бот следит за свободными местами и пишет вам, когда появляется шанс записаться.",
    "",
    "Здесь можно:",
    "• площадки",
    "• формат игры",
    "• длительность",
    "• одну или несколько дат",
    "• минимальное количество мест",
    "",
    "По умолчанию уведомление приходит тогда, когда запись уже открыта и можно нажимать кнопку на сайте.",
    "",
    "Есть и режим <b>«Мгновенная бронь (beta)»</b>:",
    "• вы заранее задаёте площадку, формат, дату, время и количество мест",
    "• если появляется подходящий слот, бот пытается сразу удержать его",
    "• после этого вам нужно быстро прислать код из SMS, чтобы закончить запись",
    "",
    "⚠️ <b>Важно:</b> мгновенная бронь — тестовая функция. Она может не сработать.",
    "",
    "⚠️ <b>Важно:</b> официальная запись всё равно требует код из SMS. Мы не можем обойти этот шаг: после отправки SMS вам нужно прислать код боту, иначе запись не завершится.",
    "",
    "<i>Нажмите кнопку ниже, чтобы настроить уведомления.</i>",
  ].join("\n");

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, buildMainMenuKeyboard());
    return;
  }

  await sendTelegramMessage(chatId, text, buildMainMenuKeyboard());
}

async function renderMenuAsNewMessage(chatId: string): Promise<void> {
  await renderMenu(chatId, null);
}

async function renderWizard(chatId: string, state: WizardState): Promise<void> {
  const text = buildStepText(state);
  const keyboard = buildStepKeyboard(state);
  let messageId = state.message_id;

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, keyboard);
  } else {
    messageId = await sendTelegramMessage(chatId, text, keyboard);
  }

  setState(chatId, {
    ...state,
    message_id: messageId,
  });
}

async function renderSubscriptionsList(
  chatId: string,
  messageId: number | null,
  mode: "list" | "unsubscribe",
): Promise<void> {
  const subscriptions = listSubscriptionsByChat(chatId).filter(
    (subscription) => subscription.active,
  );
  const text = subscriptions.length
    ? subscriptions
        .map((subscription) =>
          [
            `<b>Подписка #${subscription.id}</b>`,
            subscriptionSummary(subscription),
          ].join("\n"),
        )
        .join("\n\n")
    : "У вас пока нет активных подписок.";

  const rows = subscriptions.map((subscription) => [
    button(
      mode === "unsubscribe"
        ? `Отключить #${subscription.id}`
        : `Подписка #${subscription.id}`,
      mode === "unsubscribe" ? `unsub|${subscription.id}` : "noop|list",
    ),
  ]);

  rows.push([button("⬅️ В меню", "menu|home")]);
  const replyMarkup = { inline_keyboard: rows };

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
    return;
  }

  await sendTelegramMessage(chatId, text, replyMarkup);
}

async function renderInstantBookingList(
  chatId: string,
  messageId: number | null,
  mode: "list" | "cancel",
): Promise<void> {
  const requests = listActiveInstantRequestsByChat(chatId);
  const text = requests.length
    ? requests
        .map((request) =>
          [
            `<b>Beta-заявка #${request.id}</b>`,
            `📍 ${escapeHtml(getVenueLabel(request.venue_id))}`,
            `🎾 ${escapeHtml(getEventTypeLabel(request.event_type))}`,
            `⏱ ${request.duration_minutes} мин`,
            `🎟 ${request.tickets_count} мест`,
            `📅 ${escapeHtml(formatDateHuman(request.event_date))}`,
            `🕒 ${escapeHtml(request.start_time)}`,
            "🎾 Корт: любой подходящий",
            `Статус: ${
              request.status === "awaiting_code"
                ? "ждём код из SMS"
                : "в очереди"
            }`,
          ].join("\n"),
        )
        .join("\n\n")
    : "У вас пока нет активных очередей на мгновенную бронь.";

  const rows = requests.map((request) => [
    button(
      mode === "cancel"
        ? `Отменить beta-заявку #${request.id}`
        : `Beta-заявка #${request.id}`,
      mode === "cancel" ? `instantcancel|${request.id}` : "noop|instant",
    ),
  ]);

  rows.push([button("⬅️ В меню", "menu|home")]);
  const replyMarkup = { inline_keyboard: rows };

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
    return;
  }

  await sendTelegramMessage(chatId, text, replyMarkup);
}

async function handleSubscriptionCallback(
  chatId: string,
  messageId: number,
  parts: string[],
): Promise<void> {
  const state = getState(chatId) || createInitialWizardState(messageId);
  state.message_id = messageId;
  const category = parts[1];
  const action = parts[2];
  const value = parts[3];

  if (category === "cancel") {
    clearState(chatId);
    await renderMenu(chatId, messageId);
    return;
  }

  if (category === "back") {
    await renderWizard(chatId, popHistory(state));
    return;
  }

  if (category === "venues") {
    if (action === "toggle" && value) {
      state.data.venues = state.data.venues.includes(value)
        ? state.data.venues.filter((item) => item !== value)
        : Array.from(new Set([...state.data.venues, value]));
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      const allVenueIds = Object.keys(VENUES);
      state.data.venues =
        state.data.venues.length === allVenueIds.length ? [] : allVenueIds;
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.venues.length) {
      state.history.push(state.step);
      state.step = "event_types";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "event_types") {
    if (action === "toggle" && value) {
      state.data.event_types = state.data.event_types.includes(value)
        ? state.data.event_types.filter((item) => item !== value)
        : Array.from(new Set([...state.data.event_types, value]));
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      const allEventTypes = [...SUPPORTED_MONITOR_EVENT_TYPES];
      state.data.event_types =
        state.data.event_types.length === allEventTypes.length
          ? []
          : allEventTypes.map(String);
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.event_types.length) {
      state.history.push(state.step);
      state.step = "durations";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "durations") {
    if (action === "toggle" && value) {
      const durationValue = Number(value);
      state.data.durations = state.data.durations.includes(durationValue)
        ? state.data.durations.filter((item) => item !== durationValue)
        : Array.from(new Set([...state.data.durations, durationValue])).sort(
            (left, right) => left - right,
          );
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      const allDurations = [...DURATION_OPTIONS];
      state.data.durations =
        state.data.durations.length === allDurations.length
          ? []
          : [...allDurations];
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.durations.length) {
      state.history.push(state.step);
      state.step = "tickets";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "tickets" && action === "set" && value) {
    state.data.min_raw_tickets = Number(value) || 1;
    state.history.push(state.step);
    state.step = "date_input";
    await renderWizard(chatId, state);
    return;
  }

  if (category === "notify") {
    if (action === "toggle" && value) {
      state.data.notify_modes = normalizeNotifyModes(
        state.data.notify_modes.includes(value)
          ? state.data.notify_modes.filter((item) => item !== value)
          : [...state.data.notify_modes, value],
      );
      await renderWizard(chatId, state);
      return;
    }

    const targetDates = state.data.date_filters?.length
      ? state.data.date_filters
      : [""];
    const subscriptionIds = targetDates.map((dateFilter) =>
      createSubscription({
        chat_id: chatId,
        venues: state.data.venues.length
          ? state.data.venues
          : Object.keys(VENUES),
        event_types: state.data.event_types.length
          ? state.data.event_types
          : ["free_play"],
        durations: state.data.durations.length ? state.data.durations : [60],
        start_times: state.data.start_times?.length
          ? state.data.start_times
          : [],
        min_raw_tickets: state.data.min_raw_tickets || 1,
        date_filter: dateFilter,
        notify_modes: normalizeNotifyModes(
          action === "default"
            ? [...DEFAULT_NOTIFY_MODES]
            : state.data.notify_modes.length
              ? state.data.notify_modes
              : [...DEFAULT_NOTIFY_MODES],
        ),
      }),
    );
    clearState(chatId);
    await editTelegramMessage(
      chatId,
      messageId,
      [
        "<b>✅ Готово</b>",
        subscriptionIds.length === 1
          ? `Сохранил подписку #${subscriptionIds[0]}.`
          : `Сохранил ${subscriptionIds.length} подписки на выбранные даты.`,
        "",
        subscriptionSummary(state.data),
      ].join("\n"),
      {
        inline_keyboard: [[button("📋 В меню", "menu|home")]],
      },
    );
  }
}

async function handleInstantCallback(
  chatId: string,
  messageId: number,
  parts: string[],
): Promise<void> {
  const state = getState(chatId) || createInitialInstantWizardState(messageId);
  state.message_id = messageId;
  const category = parts[1];
  const action = parts[2];
  const value = parts[3];

  if (category === "cancel") {
    clearState(chatId);
    await renderMenu(chatId, messageId);
    return;
  }

  if (category === "back") {
    await renderWizard(chatId, popHistory(state));
    return;
  }

  if (category === "intro" && action === "continue") {
    state.history.push(state.step);
    state.step = "instant_venue";
    await renderWizard(chatId, state);
    return;
  }

  if (category === "venue") {
    if (action === "set" && value) {
      state.data.instant_venue = value;
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.instant_venue) {
      state.history.push(state.step);
      state.step = "instant_event_type";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "event_type") {
    if (action === "set" && value) {
      state.data.instant_event_type = value;
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.instant_event_type) {
      state.history.push(state.step);
      state.step = "instant_duration";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "duration") {
    if (action === "set" && value) {
      state.data.instant_duration = Number(value) || 0;
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.instant_duration) {
      state.history.push(state.step);
      state.step = "instant_tickets";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "tickets") {
    if (action === "set" && value) {
      state.data.instant_tickets = Number(value) || 1;
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.instant_tickets) {
      state.history.push(state.step);
      state.step = "instant_date";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "alerts") {
    if (action === "set") {
      state.data.instant_notify_on_match = value === "yes";
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done") {
      state.history.push(state.step);
      state.step = state.data.instant_notify_on_match
        ? "instant_alerts_gray"
        : "instant_first_name";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "alerts_gray") {
    if (action === "set") {
      state.data.instant_notify_gray = value === "yes";
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done") {
      state.history.push(state.step);
      state.step = "instant_first_name";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "queue" && action === "create") {
    if (listActiveInstantRequestsByChat(chatId).length >= 3) {
      await editTelegramMessage(
        chatId,
        messageId,
        "У вас уже есть 3 активные beta-заявки на мгновенную бронь. Дождитесь завершения одной из них или отмените лишнюю очередь.",
        {
          inline_keyboard: [[button("📋 В меню", "menu|home")]],
        },
      );
      clearState(chatId);
      return;
    }

    let alertSubscriptionId: number | null = null;
    if (
      state.data.instant_notify_on_match &&
      state.data.instant_venue &&
      state.data.instant_event_type &&
      state.data.instant_duration &&
      state.data.instant_date &&
      state.data.instant_time
    ) {
      alertSubscriptionId = createSubscription({
        chat_id: chatId,
        venues: [String(state.data.instant_venue)],
        event_types: [String(state.data.instant_event_type)],
        durations: [Number(state.data.instant_duration)],
        start_times: [String(state.data.instant_time)],
        min_raw_tickets: Number(state.data.instant_tickets || 1),
        date_filter: String(state.data.instant_date),
        notify_modes: normalizeNotifyModes(
          state.data.instant_notify_gray
            ? ["ready", "disabled_visible"]
            : ["ready"],
        ),
      });
    }

    const queuePosition =
      countQueueForSlot({
        venue_id: String(state.data.instant_venue || ""),
        court_id: "",
        event_type: String(state.data.instant_event_type || ""),
        event_date: String(state.data.instant_date || ""),
        start_time: String(state.data.instant_time || ""),
        duration_minutes: Number(state.data.instant_duration || 0),
      }) + 1;

    const requestId = createInstantBookingRequest({
      chat_id: chatId,
      venue_id: String(state.data.instant_venue || ""),
      court_id: "",
      event_type: String(state.data.instant_event_type || ""),
      event_date: String(state.data.instant_date || ""),
      start_time: String(state.data.instant_time || ""),
      duration_minutes: Number(state.data.instant_duration || 0),
      tickets_count: Number(state.data.instant_tickets || 1),
      first_name: String(state.data.instant_first_name || ""),
      last_name: String(state.data.instant_last_name || ""),
      phone: String(state.data.instant_phone || ""),
      email: String(state.data.instant_email || ""),
      subscribe_on_match: Boolean(state.data.instant_notify_on_match),
      notify_gray: Boolean(state.data.instant_notify_gray),
      alert_subscription_id: alertSubscriptionId,
    });

    clearState(chatId);
    await editTelegramMessage(
      chatId,
      messageId,
      [
        "<b>✅ Beta-заявка создана</b>",
        `Номер заявки: <b>#${requestId}</b>`,
        `Ваше место в очереди на этот слот: <b>${queuePosition}</b>.`,
        "",
        "Когда нужный слот появится, мы попробуем удержать его и сразу попросим у вас SMS-код.",
        "",
        "⚠️ <b>Важно:</b> мы передадим ваши данные и код только в официальное API Mos Sport / mos.ru.",
        "",
        "⚠️ <b>Важно:</b> официальная запись требует код из SMS. Мы не можем пропустить этот шаг: без вашего кода запись не завершится.",
        "",
        "⚠️ <b>Важно:</b> после отправки SMS у вас будет около двух минут на ответ. Если код не ввести в бот вовремя, слот будет аннулирован и снова станет доступен для ручной записи.",
        "",
        "🙂 Напомним: это студенческий некоммерческий проект. Мы не просим оплату, не навязываем услуги и не делаем ничего подобного — всё работает бесплатно.",
        "",
        'Если вы не доверяете передавать код через бота, лучше воспользуйтесь сервисом уведомлений и записывайтесь вручную на <a href="https://outdoor.sport.mos.ru/#venues-events">официальном сайте</a>.',
      ].join("\n"),
      {
        inline_keyboard: [[button("📋 В меню", "menu|home")]],
      },
    );
    return;
  }
}

async function handleTextMessage(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  saveUser(message.from);

  const text = String(message.text || "").trim();
  if (text === "/start") {
    clearState(chatId);
    if (hasTelegramConsent(chatId)) {
      await renderMenu(chatId);
      return;
    }

    await renderConsentPrompt(chatId, { mode: "initial", forceNew: true });
    return;
  }

  if (!hasTelegramConsent(chatId)) {
    clearState(chatId);
    await renderConsentPrompt(chatId, { mode: "initial", forceNew: true });
    return;
  }

  if (text === "/subscriptions") {
    await renderSubscriptionsList(chatId, null, "list");
    return;
  }

  const awaitingCodeRequest = getAwaitingCodeRequestByChat(chatId);
  if (awaitingCodeRequest) {
    if (!isValidCode(text)) {
      await sendTelegramMessage(
        chatId,
        "Неправильный формат кода подтверждения! Нужны только 4, 5 или 6 цифр.",
        null,
      );
      return;
    }

    const verifyResult = await verifyBookingSms({
      session_id: awaitingCodeRequest.session_id,
      hold_id: awaitingCodeRequest.hold_id,
      phone: awaitingCodeRequest.phone,
      code: text,
      otp: text,
    });

    if (
      verifyResult.status >= 400 ||
      !verifyResult.isJson ||
      (verifyResult.body as { status?: string })?.status !== "verified"
    ) {
      await sendJsonErrorMessage(
        chatId,
        "Не удалось подтвердить код. Вот ответ сервиса:",
        verifyResult.body,
      );
      finishInstantBookingRequest(
        awaitingCodeRequest.id,
        "failed",
        JSON.stringify(verifyResult.body),
      );
      return;
    }

    const confirmResult = await confirmBooking({
      session_id: awaitingCodeRequest.session_id,
      hold_id: awaitingCodeRequest.hold_id,
      first_name: awaitingCodeRequest.first_name,
      last_name: awaitingCodeRequest.last_name,
      phone: awaitingCodeRequest.phone,
      email: awaitingCodeRequest.email,
      privacy_policy_accepted: true,
      personal_data_accepted: true,
    });

    if (confirmResult.status >= 400) {
      await sendJsonErrorMessage(
        chatId,
        "К сожалению, не удалось завершить запись. Вот ответ сервиса:",
        confirmResult.body,
      );
      finishInstantBookingRequest(
        awaitingCodeRequest.id,
        "failed",
        JSON.stringify(confirmResult.body),
      );
      if (awaitingCodeRequest.alert_subscription_id) {
        deactivateSubscription(
          awaitingCodeRequest.alert_subscription_id,
          "instant_booking_finished",
        );
      }
      return;
    }

    finishInstantBookingRequest(awaitingCodeRequest.id, "confirmed");
    if (awaitingCodeRequest.alert_subscription_id) {
      deactivateSubscription(
        awaitingCodeRequest.alert_subscription_id,
        "instant_booking_finished",
      );
    }
    await sendTelegramMessage(
      chatId,
      "✅ Запись подтверждена. Код и ваши данные были переданы только в официальное API Mos Sport / mos.ru.",
      null,
    );
    return;
  }

  const state = getState(chatId);
  if (!state) {
    return;
  }

  if (state.flow === "subscription" && state.step === "date_input") {
    const parsedDate = parseFlexibleDateInput(text);
    if (!parsedDate.ok || !(parsedDate.dates?.length || parsedDate.date)) {
      await sendTelegramMessage(chatId, parsedDate.error || "Не понял дату.", {
        inline_keyboard: [
          [button("⬅️ Назад", "sub|back"), button("❌ Отмена", "sub|cancel")],
        ],
      });
      return;
    }

    state.data.date_filters =
      parsedDate.dates || (parsedDate.date ? [parsedDate.date] : []);
    state.history.push(state.step);
    state.step = "notify_modes";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.flow !== "instant_booking") {
    return;
  }

  if (state.step === "instant_date") {
    const parsedDate = parseFlexibleDateInput(text);
    const parsedDates =
      parsedDate.dates || (parsedDate.date ? [parsedDate.date] : []);
    if (!parsedDate.ok || parsedDates.length !== 1) {
      await sendTelegramMessage(
        chatId,
        parsedDate.error || "Нужна одна понятная дата.",
        null,
      );
      return;
    }
    state.data.instant_date = parsedDates[0];
    state.history.push(state.step);
    state.step = "instant_time";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.step === "instant_time") {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) {
      await sendTelegramMessage(
        chatId,
        "Неправильный формат времени. Нужен формат ЧЧ:ММ, например 19:00.",
        null,
      );
      return;
    }
    state.data.instant_time = text;
    state.history.push(state.step);
    state.step = "instant_alerts";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.step === "instant_first_name") {
    if (!text) {
      await sendTelegramMessage(chatId, "Имя не должно быть пустым.", null);
      return;
    }
    state.data.instant_first_name = text;
    state.history.push(state.step);
    state.step = "instant_last_name";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.step === "instant_last_name") {
    if (!text) {
      await sendTelegramMessage(chatId, "Фамилия не должна быть пустой.", null);
      return;
    }
    state.data.instant_last_name = text;
    state.history.push(state.step);
    state.step = "instant_phone";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.step === "instant_phone") {
    const normalizedPhone = normalizePhone(text);
    if (!normalizedPhone) {
      await sendTelegramMessage(
        chatId,
        "Нужен корректный российский номер телефона.",
        null,
      );
      return;
    }
    state.data.instant_phone = normalizedPhone;
    state.history.push(state.step);
    state.step = "instant_email";
    state.message_id = null;
    await renderWizard(chatId, state);
    return;
  }

  if (state.step === "instant_email") {
    if (!isValidEmail(text)) {
      await sendTelegramMessage(
        chatId,
        "Нужен корректный email, например name@example.com.",
        null,
      );
      return;
    }
    state.data.instant_email = text.trim();
    state.history.push(state.step);
    state.step = "instant_queue_confirm";
    state.message_id = null;
    await renderWizard(chatId, state);
  }
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = String(
    callbackQuery.from?.id || callbackQuery.message?.chat.id || "",
  );
  const messageId = Number(callbackQuery.message?.message_id || 0);
  const data = String(callbackQuery.data || "");
  if (!chatId || !data) {
    return;
  }

  saveUser(callbackQuery.from);
  const parts = data.split("|");
  const sourceMessageText = callbackQuery.message?.text || "";

  if (parts[0] === "consent") {
    if (parts[1] === "decline") {
      clearState(chatId);
      await renderConsentPrompt(chatId, {
        messageId,
        mode: "declined",
      });
      await answerCallbackQuery(callbackQuery.id);
      return;
    }

    if (parts[1] === "accept") {
      setConsentAccepted({
        subjectType: "telegram",
        subjectId: chatId,
        source: "telegram_bot",
        documentUrl: CONSENT_DOCUMENT_URL,
      });
      clearState(chatId);
      await renderMenu(chatId, messageId);
      await answerCallbackQuery(callbackQuery.id, "Согласие сохранено");
      return;
    }
  }

  if (!hasTelegramConsent(chatId)) {
    clearState(chatId);
    await renderConsentPrompt(chatId, { mode: "initial", forceNew: true });
    await answerCallbackQuery(
      callbackQuery.id,
      "Сначала нужно принять согласие на обработку персональных данных.",
    );
    return;
  }

  if (parts[0] === "menu") {
    if (parts[1] === "home" && isAlertMessageText(sourceMessageText)) {
      clearState(chatId);
      await renderMenuAsNewMessage(chatId);
      await answerCallbackQuery(callbackQuery.id);
      return;
    }

    if (parts[1] === "subscribe") {
      const state = createInitialWizardState(messageId);
      setState(chatId, state);
      await renderWizard(chatId, state);
    } else if (parts[1] === "instant") {
      if (listActiveInstantRequestsByChat(chatId).length >= 3) {
        await sendTelegramMessage(
          chatId,
          "У вас уже есть 3 активные beta-заявки. Дождитесь завершения одной из них или отмените лишнюю очередь.",
          null,
        );
      } else {
        const state = createInitialInstantWizardState(messageId);
        setState(chatId, state);
        await renderWizard(chatId, state);
      }
    } else if (parts[1] === "instant_list") {
      clearState(chatId);
      await renderInstantBookingList(chatId, messageId, "list");
    } else if (parts[1] === "instant_cancel") {
      clearState(chatId);
      await renderInstantBookingList(chatId, messageId, "cancel");
    } else if (parts[1] === "list") {
      clearState(chatId);
      await renderSubscriptionsList(chatId, messageId, "list");
    } else if (parts[1] === "unsubscribe") {
      clearState(chatId);
      await renderSubscriptionsList(chatId, messageId, "unsubscribe");
    } else {
      clearState(chatId);
      await renderMenu(chatId, messageId);
    }
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "menu_new") {
    clearState(chatId);
    await renderMenuAsNewMessage(chatId);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "sub") {
    await handleSubscriptionCallback(chatId, messageId, parts);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "instant") {
    await handleInstantCallback(chatId, messageId, parts);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "unsub" && parts[1]) {
    deactivateSubscriptionForChat(
      Number(parts[1]),
      chatId,
      "user_unsubscribed",
    );
    await renderSubscriptionsList(chatId, messageId, "unsubscribe");
    await answerCallbackQuery(callbackQuery.id, "Подписка отключена");
    return;
  }

  if (parts[0] === "instantcancel" && parts[1]) {
    const targetId = Number(parts[1]);
    const request = listActiveInstantRequestsByChat(chatId).find(
      (item) => item.id === targetId,
    );
    if (request) {
      finishInstantBookingRequest(request.id, "cancelled");
      if (request.alert_subscription_id) {
        deactivateSubscription(
          request.alert_subscription_id,
          "instant_booking_cancelled",
        );
      }
    }
    await renderInstantBookingList(chatId, messageId, "cancel");
    await answerCallbackQuery(callbackQuery.id, "Beta-заявка отменена");
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
}

export async function startTelegramPolling(): Promise<void> {
  if (!TELEGRAM_API_BASE || telegramLoopStarted) {
    return;
  }

  telegramLoopStarted = true;

  while (true) {
    try {
      const offset = Number(getKv("telegram_update_offset") || "0");
      const response = await getTelegramUpdates(
        offset,
        TELEGRAM_POLL_TIMEOUT_SECONDS,
      );

      if (!response.ok) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const updates = response.result || [];
      for (const update of updates as TelegramUpdate[]) {
        setKv("telegram_update_offset", String(Number(update.update_id) + 1));
        if (update.message?.text) {
          await handleTextMessage(update.message);
        }
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (error) {
      console.error("Telegram polling failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
