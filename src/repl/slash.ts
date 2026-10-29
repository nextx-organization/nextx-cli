// Slash commands of the chat. One list for the menu, `/help` and `help --json` (docs are generated from it).
import { tr } from "../core/i18n.js";
import { brand, type PlatformId } from "../core/brand.js";

const notes = () => `${brand().bin.toUpperCase()}.md`;

export interface SlashCommand {
  name: string;
  args?: string;
  description: () => string;
  /** Only on these backends; unset = everywhere. */
  platforms?: PlatformId[];
}

export const SLASH: SlashCommand[] = [
  { name: "help", description: () => tr("Danh sách lệnh và phím tắt", "Commands and shortcuts") },
  { name: "new", description: () => tr("Hội thoại mới (giữ workspace, agent)", "New conversation (keeps workspace, agent)") },
  { name: "resume", args: "[query]", description: () => tr("Mở lại hội thoại cũ", "Resume an earlier conversation") },
  { name: "rename", args: "<name>", description: () => tr("Đặt tên hội thoại này", "Rename this conversation") },
  { name: "pin", description: () => tr("Ghim / bỏ ghim hội thoại", "Pin / unpin this conversation") },
  { name: "workspace", args: "[code]", description: () => tr("Đổi workspace đang làm việc", "Switch workspace") },
  { name: "agent", args: "[code]", description: () => tr("Chọn Agent: Trợ lý chung, Bán hàng, CSKH…", "Choose an Agent: general, sales, support…"), platforms: ["nextx"] },
  { name: "mode", args: "read|propose|auto", description: () => tr("Permission mode: chỉ đọc · đề xuất · tự ghi việc thường", "Permission mode: read · propose · auto") },
  { name: "model", args: "[name]", description: () => tr(`Đổi model: ${brand().aiName} hoặc model của bạn`, `Switch model: ${brand().aiName} or your own`) },
  { name: "attach", args: "<file>", description: () => tr("Đính kèm tệp Excel / CSV / ảnh / tệp chữ", "Attach an Excel / CSV / image / text file") },
  { name: "pending", description: () => tr("Write proposal đang chờ xác nhận", "Writes waiting for confirmation"), platforms: ["nextx"] },
  { name: "undo", args: "[id]", description: () => tr("Hoàn tác lần ghi gần nhất", "Undo the last write") },
  { name: "journal", description: () => tr("Nhật ký những gì AI đã ghi", "Journal of what the AI wrote"), platforms: ["nextx"] },
  { name: "why", args: "[runId]", description: () => tr("Vì sao AI trả lời vậy (các bước, công cụ đã gọi)", "Why the AI answered that way (steps, tools)") },
  { name: "memory", description: () => tr("AI đang nhớ gì về công ty — sửa, khoá, quên", "What the AI remembers — edit, lock, forget") },
  { name: "schedule", args: '"question" daily 08:00', description: () => tr("Lên lịch một câu hỏi chạy hằng ngày / tuần / tháng", "Schedule a question daily / weekly / monthly") },
  { name: "library", description: () => tr("Ảnh, tài liệu, tệp AI đã tạo", "Images, documents and files the AI produced"), platforms: ["nextx"] },
  { name: "export", args: "md|json [file]", description: () => tr("Xuất hội thoại ra Markdown / JSON", "Export the conversation to Markdown / JSON") },
  { name: "tools", description: () => tr("Công cụ AI bạn đang được dùng (theo quyền thật)", "AI tools you can use (by your real permissions)") },
  { name: "usage", description: () => brand().platform === "nextx" ? tr("Lượt AI tháng này", "AI turns this month") : tr("Câu hỏi AI còn lại tuần này", "AI questions left this week") },
  { name: "feedback", args: "up|down", description: () => tr("Báo câu trả lời vừa rồi tốt / chưa tốt", "Rate the last answer") },
  { name: "support", args: "<problem>", description: () => tr("Chuyển cho nhân viên hỗ trợ (mở ticket)", "Hand over to a support agent (ticket)"), platforms: ["nextx"] },
  { name: "status", description: () => tr("Tài khoản, workspace, môi trường, phiên bản", "Account, workspace, environment, version") },
  { name: "doctor", description: () => tr("Kiểm kết nối, đồng hồ, token, gói", "Check connectivity, clock, token, plan") },
  { name: "config", args: "[key value]", description: () => tr("Cài đặt: ngôn ngữ, màu, thông báo cập nhật", "Settings: language, color, update notices") },
  { name: "init", description: () => tr(`Tạo ${notes()}: chỉ dẫn riêng cho thư mục này`, `Create ${notes()}: instructions for this folder`) },
  { name: "mcp", description: () => tr("Cài máy chủ MCP vào client khác", "Install the MCP server into another client") },
  { name: "logout", description: () => tr("Đăng xuất hồ sơ này", "Log out this profile") },
  { name: "clear", description: () => tr("Xoá màn hình (không xoá hội thoại)", "Clear the screen (keeps the conversation)") },
  { name: "exit", description: () => tr("Thoát", "Exit") },
];

export const SHORTCUTS: { keys: string; description: () => string }[] = [
  { keys: "Enter · Shift+Enter (\\ + Enter)", description: () => tr("Gửi · xuống dòng", "Send · new line") },
  { keys: "/", description: () => tr("Menu lệnh", "Command menu") },
  { keys: "@", description: () => tr("Đính kèm tệp, chọn Agent cho câu này", "Attach a file, pick an Agent for this message") },
  { keys: "#", description: () => tr(`Ghi nhớ nhanh vào ${notes()} của thư mục`, `Quick note into this folder's ${notes()}`) },
  { keys: "Shift+Tab", description: () => tr("Xoay permission mode", "Cycle permission mode") },
  { keys: "Esc", description: () => tr("Dừng câu trả lời đang chạy", "Stop the running answer") },
  { keys: "Esc Esc", description: () => tr("Sửa lại câu vừa gửi", "Edit the last message") },
  { keys: "↑ / ↓", description: () => tr("Lịch sử câu đã gõ", "Input history") },
  { keys: "Ctrl+O", description: () => tr("Mở / gập chi tiết các bước", "Expand / collapse steps") },
  { keys: "Ctrl+L", description: () => tr("Xoá màn", "Clear screen") },
  { keys: "Ctrl+C · Ctrl+D", description: () => tr("Huỷ dòng đang gõ (2 lần để thoát) · thoát", "Clear input (twice to exit) · exit") },
];

/** Commands of the current brand's backend — menu, `/help` and `help --json` all read this. */
export function slashCommands(): SlashCommand[] {
  return SLASH.filter((s) => !s.platforms || s.platforms.includes(brand().platform));
}

export function matchSlash(prefix: string): SlashCommand[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return slashCommands().filter((s) => s.name.startsWith(p));
}
