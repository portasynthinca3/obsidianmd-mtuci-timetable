import {
	App,
	Notice,
	Plugin, PluginSettingTab,
	requestUrl, RequestUrlParam,
	Setting,
	TFile, TFolder,
	Vault
} from "obsidian";
import moment from "moment";
import dedent from "dedent";

moment.updateLocale("ru", {
	week: {
		dow: 1
	}
});

// Время поездки: отдельно туда и обратно
interface CommuteTime {
	forwards: string;
	backwards: string;
}

// Настройки плагина
interface MtuciTimetableSettings {
	apiKey: string;
	generateCommute: boolean;
	path: string;
	commute: {
		OP: CommuteTime;
		A: CommuteTime;
	};
}

// Настройки по умолчанию
const DEFAULT_SETTINGS: MtuciTimetableSettings = {
	apiKey: "",
	generateCommute: true,
	path: "календарь/мтуси",
	commute: {
		OP: { forwards: "", backwards: "" },
		A: { forwards: "", backwards: "" },
	}
}

enum SubjectType {
	LECTURE = 1,
	PRACTICE = 2,
	LAB = 3
}

// Объект расписания
type Timetable = {
	day: number,
	parity: 1 | 2,
	lessons: Record<number, {
		audience: string[],
		day: number,
		discipline: [string],
		number: number,
		teacher: string[],
		time_start: string,
		time_end: string,
		type: SubjectType
	}>
}[];

// Обработанный объект расписания только с интересующей нас информацией
enum Building {
	OP = 1,
	A = 2
}
type CompressedTimetable = {
	day: number,
	parity: 1 | 2,
	time_start: string,
	time_end: string,
	building: Building
}[];

export default class MtuciTimetablePlugin extends Plugin {
	settings: MtuciTimetableSettings;

	async apiRequest(endpoint: string, params?: RequestUrlParam) {
		const request = {
			...params,
			url: `https://apimtuci.ru/${endpoint}`,
		};
		const response = await requestUrl(request);
		console.log("mtuci: apiRequest", request, response);
		return response;
	}

	extractCookie(cookies: string[], cookie: string) {
		return decodeURIComponent(cookies
			.find((v) => v.startsWith(cookie))
			?.split(";")[0]
			.split("=")[1]
			?? "");
	}

	async getTimetable() {
		console.log("mtuci: getTimetable");

		// Получаем изначальные куки
		let response = await this.apiRequest("web");
		let cookies = response.headers["set-cookie"] as unknown as string[];
		const xsrfToken = this.extractCookie(cookies, "XSRF-TOKEN");
		const session = this.extractCookie(cookies, "mtusi_tech_session");
		
		// Формируем контекст с заголовками
		const context = {
			url: "blah",
			headers: {
				"Cookie": `XSRF-TOKEN=${xsrfToken}; mtusi_tech_session=${session}`,
				"X-XSRF-TOKEN": xsrfToken
			}
		};

		// Авторизуемся
		response = await this.apiRequest(`api/web/token/validate?token=${this.settings.apiKey}`, {
			...context,
			method: "POST"
		});
		cookies = response.headers["set-cookie"] as unknown as string[];
		const token = this.extractCookie(cookies, "token");
		context.headers["Cookie"] += `; token=${token}`;

		// Получаем данные
		const json = (await this.apiRequest("api/web/get", context)).json;
		const timetable = json.content.timetable.content.timetable as Timetable;

		return [timetable, json.content.parity]; // расписание и чётность текущей недели
	}

	compressTimetable(timetable: Timetable): CompressedTimetable {
		// @ts-expect-error мы убрали undefined при помощи filter
		return timetable
			.map((entry) => ({
				day: entry.day,
				parity: entry.parity,
				time_start: Object.values(entry.lessons)
					.find((x) => x.time_start !== "--")?.time_start,
				time_end: Object.values(entry.lessons)
					.findLast((x) => x.time_end !== "--")?.time_end,
				building: (Object.values(entry.lessons)
					.find((x) => x.audience[0] !== "--")?.audience[0].includes("ОП"))
					? Building.OP : Building.A
			}))
			.filter((entry) => entry.time_start !== undefined && entry.time_end !== undefined);
	}

	async reloadTimetable() {
		console.log("mtuci: reloadTimetable");

		let table: Timetable = [];
		let parity = 0;
		try {
			[table, parity] = await this.getTimetable();
		} catch(ex) {
			console.error(ex);
			new Notice("Не удалось загрузить расписание. Проверьте подключение к интернету и правильность токена в настройках плагина.");
			return;
		}
		console.table(table);

		// Выделяем нужную нам информацию
		const compTable = this.compressTimetable(table);
		console.table(compTable);

		// // Удаляем старые заметки
		// const oldDir = this.app.vault.getAbstractFileByPath(this.settings.path) as TFolder;
		// if(oldDir && !oldDir.isRoot()) {
		// 	for(const f of oldDir.children) {
		// 		this.app.vault.delete(f);
		// 	}
		// }

		// // Создаём новую структуру
		// this.app.vault.createFolder(`${this.settings.path}/учёба`);
		// this.app.vault.createFolder(`${this.settings.path}/дорога`);

		// Определяем временные рамки
		const thisMonday = moment().locale("ru").startOf("week");

		// Удаляем заметки на эту и следующую неделю
		for(let i = 0; i < 14; i++) {
			const name = thisMonday.clone().add(i, "days").format("YYYY-MM-DD");
			for (const [folder, suffix] of [["учёба", ""], ["дорога", "-1"], ["дорога", "-2"]]) {
				const file = this.app.vault.getAbstractFileByPath(`${this.settings.path}/${folder}/${name}${suffix}.md`);
				if(file)
					this.app.vault.delete(file);
			}
		}

		// Создаём заметки на эту и следующую неделю
		for(const entry of compTable) {
			// Оборачиваем чётность, если сейчас чётная неделя
			if(parity === 2)
				entry.parity = (entry.parity === 1) ? 2 : 1;

			// Заметка с учёбой
			const offs = entry.day - 1 + ((entry.parity - 1) * 7);
			const date = thisMonday.clone().add(offs, "days").format("YYYY-MM-DD");
			this.app.vault.create(`${this.settings.path}/учёба/${date}.md`,
				dedent`---
				title: "Учёба (${entry.building == Building.OP ? "ОП" : "А"})"
				allDay: false
				startTime: ${entry.time_start}
				endTime: ${entry.time_end}
				date: ${date}
				completed: null
				---`);
			
			if(this.settings.generateCommute) {
				const commute = this.settings.commute[entry.building == Building.OP ? "OP" : "A"];

				// Заметка с дорогой туда
				const commuteStart = moment(entry.time_start, "HH:mm")
					.subtract(moment.duration(commute.forwards));
				this.app.vault.create(`${this.settings.path}/дорога/${date}-1.md`,
					dedent`---
					title: "Дорога"
					allDay: false
					startTime: ${commuteStart.format("HH:mm")}
					endTime: ${entry.time_start}
					date: ${date}
					completed: null
					---`);

				// Заметка с дорогой обратно
				const commuteEnd = moment(entry.time_end, "HH:mm")
					.add(moment.duration(commute.backwards));
				this.app.vault.create(`${this.settings.path}/дорога/${date}-2.md`,
					dedent`---
					title: "Дорога"
					allDay: false
					startTime: ${entry.time_end}
					endTime: ${commuteEnd.format("HH:mm")}
					date: ${date}
					completed: null
					---`);
			}
		}
	}

	async onload() {
		await this.loadSettings();

		// Кнопка на левой панели (в меню на мобильных устройствах)
		this.addRibbonIcon("refresh-cw", "Обновить расписание", () => this.reloadTimetable());

		// Команда в палитре
		this.addCommand({
			id: "mtuci-timetable-update",
			name: "Обновить расписание",
			callback: () => this.reloadTimetable()
		});

		// Вкладка с настройками
		this.addSettingTab(new MtuciTimetableSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MtuciTimetableSettingTab extends PluginSettingTab {
	plugin: MtuciTimetablePlugin;

	constructor(app: App, plugin: MtuciTimetablePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Токен API")
			.setDesc("todo: добавить ссылку на приложуху")
			.addText(text => text
				.setPlaceholder("с3kР3тн0")
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Добавлять в календарь время поездки")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.generateCommute)
				.onChange(async (value) => {
					this.plugin.settings.generateCommute = value;
					await this.plugin.saveSettings();
				}));

		// Время поездок в корпуса
		function addCommuteTimeFields(
			setting: Setting,
			key: keyof MtuciTimetableSettings["commute"],
			plugin: MtuciTimetablePlugin
		) {
			setting
				.addMomentFormat(moment => moment
					.setDefaultFormat("HH:mm")
					.setPlaceholder("в корпус (чч:мм)")
					.setValue(plugin.settings.commute[key].forwards)
					.onChange(async (value) => {
						plugin.settings.commute[key].forwards = value;
						await plugin.saveSettings();
					}))
				.addMomentFormat(moment => moment
					.setDefaultFormat("HH:mm")
					.setPlaceholder("домой (чч:мм)")
					.setValue(plugin.settings.commute[key].backwards)
					.onChange(async (value) => {
						plugin.settings.commute[key].backwards = value;
						await plugin.saveSettings();
					}));
		}
		addCommuteTimeFields(new Setting(containerEl)
			.setName("Время поездки на ОП"), "OP", this.plugin);
		addCommuteTimeFields(new Setting(containerEl)
			.setName("Время поездки на А"), "A", this.plugin);
	}
}
