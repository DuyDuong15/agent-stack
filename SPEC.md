# IT Support Ticket — Đặc tả hiện hành

Business specification for the IT Support Ticket demo. See [README](README.md) for setup and usage.

## 1. Phạm vi

Nhân viên hỏi bằng tiếng Việt trong Element để tra nhân viên, ticket, thống kê và tạo ticket sau khi xác nhận. Keycloak cấp danh tính đăng nhập Matrix; Jaeger quan sát backend. Dữ liệu demo local, không phải hệ thống ticket sản xuất.

Không hỗ trợ tạo/sửa/xóa nhân viên, sửa/xóa/đóng ticket qua bot, chạy shell, email/upload, phân quyền theo nhân viên hoặc nhiều tenant. Yêu cầu ngoài phạm vi phải bị từ chối, không chuyển thành yêu cầu tạo ticket.

## 2. Dữ liệu và quy tắc đọc

| Đối tượng | Thuộc tính chính |
|---|---|
| Employee | UUID, code EMP-xxx, name, department, active |
| Ticket | UUID, code IT-xxxxxx, title, description, requesterId, assigneeId nullable, priority, status, dueAt nullable, createdAt, updatedAt |

- Hai REST API sở hữu hai SQLite riêng; không đọc DB hoặc gọi REST của nhau. MCP có SQLite draft riêng. GraphQL chỉ ghép dữ liệu qua HTTP.
- Status: OPEN, IN_PROGRESS, RESOLVED, CLOSED. Đang mở = OPEN hoặc IN_PROGRESS. Priority: LOW, MEDIUM, HIGH.
- Quá hạn = đang mở và dueAt < thời điểm đánh giá của REST; null hoặc bằng thời điểm đánh giá không quá hạn. Không suy deadline từ priority.
- Thời gian ISO8601 có timezone, lưu UTC; ngày giờ người dùng được diễn giải theo giờ Việt Nam. Khoảng lọc createdFrom/createdTo là [from, to).
- Tìm kiếm không phân biệt dấu/hoa thường; trim input. Danh sách limit 1–100, offset >= 0; Employee sắp code ASC, Ticket createdAt DESC rồi id ASC.
- Employee batch tối đa 100 ID/lần, trả missingIds. DataLoader theo từng request, bỏ trùng, chia lô và ánh xạ đúng thứ tự. Không gọi REST một lần mỗi ticket.
- Count/statistics tính tại Ticket REST trên toàn tập lọc, không đếm trang đầu hoặc để LLM tự tính. Page và statistics riêng có thể có evaluatedAt khác nhau.
- Tên trùng phải hỏi mã/phòng ban, không tự chọn UUID. Câu hỏi theo người không được âm thầm bỏ bộ lọc thành thống kê toàn hệ thống. Phạm vi toàn hệ thống phải rõ trong tin người dùng.

## 3. Contract

Nguồn chi tiết duy nhất cho field, format, validation và status HTTP: [OpenAPI 3.0.3](ticket-service/design/openapi.json). Không chép lại toàn schema trong báo cáo.

| Service | Endpoint |
|---|---|
| Employee REST | GET /employees (search/page/batch), GET /employees/{employeeId} |
| Ticket REST | GET /tickets, GET /tickets/{ticketId}, GET /ticket-statistics |
| Ticket REST ghi | POST /tickets, POST /ticket-replays (tra receipt trước khi tạo) |
| GraphQL | POST /graphql; [query SDL](ticket-service/design/schema.graphql) + [mutation SDL](ticket-service/design/schema-bai2.graphql) được nạp cùng nhau |
| MCP | POST /mcp; Streamable HTTP, không phải endpoint SSE độc lập |

Operation mẫu: [query](ticket-service/design/examples.graphql), [mutation](ticket-service/design/examples-bai2.graphql). MCP dùng query viết sẵn, LLM chỉ truyền arguments; không nhận query GraphQL tùy ý.

Tools: ping, search_employees, search_tickets, get_ticket, ticket_statistics, prepare_ticket, confirm_ticket, cancel_ticket. Read filter theo người dùng tên/mã; MCP resolve qua GraphQL trước khi dùng UUID nội bộ.

| Status MCP | Ý nghĩa và cách trả lời |
|---|---|
| ok | Có dữ liệu; nhân viên tồn tại có 0 ticket vẫn là ok |
| not_found | Không có đối tượng/kết quả tìm kiếm; không bịa |
| unavailable | Lỗi kết nối, timeout hoặc upstream; không nói “không tồn tại” |
| rejected | Input/nghiệp vụ không hợp lệ hoặc trùng; giải thích lỗi cụ thể |

GraphQL nullable relation cho phép partial data khi Employee lỗi; errors/path phân biệt lỗi upstream với ID không tồn tại. HTTP200 chưa chắc là thành công. MCP đọc body/errors và giữ phần data hợp lệ nhưng không suy đoán phần thiếu.

## 4. Tạo ticket và xác nhận

1. Hỏi title, description, requester, priority, **lựa chọn assignee**. Không tự điền requester/priority. Nếu chưa giao phải được người dùng nói rõ; assigneeId nullable ở REST không có nghĩa bot được tự mặc định. Deadline tùy chọn.
2. Resolve nhân viên; hỏi lại nếu tên trùng. Kiểm tra phạm vi yêu cầu dựa trên tin Matrix thật, không tin riêng title do LLM tạo.
3. prepare_ticket lưu draft và gửi preview; **chưa tạo ticket**. Preview có nội dung, nonce và “Xác nhận trước” theo giờ Việt Nam. Thời hạn draft khác deadline ticket.
4. Người dùng gửi `XÁC NHẬN <mã>` hoặc `HỦY <mã>` theo preview. Backend kiểm user, room, event, nonce, thời gian và nội dung bất biến. Không nhận `confirmed=true` giả lập.
5. Confirm hợp lệ → GraphQL tra replay → nếu chưa commit, kiểm requester/assignee active qua Employee → POST Ticket → receipt. Ticket REST validate hình dạng, deadline, duplicate và ghi transaction. REST nội bộ không tự xác minh employee tồn tại; service key là ranh giới tin cậy.

Ticket mới OPEN, ID/code/timestamps do server sinh. Cùng idempotency key và payload chuẩn hóa trả cùng ticket; cùng key khác payload trả 409 IDEMPOTENCY_CONFLICT. Key mới nhưng cùng requester + assignee + tiêu đề trim/casefold Unicode với ticket OPEN/IN_PROGRESS trả 409 TICKET_DUPLICATE. Chống trùng và ghi receipt cùng transaction, không chỉ dựa vào lời nhắc model.

Draft PENDING có hạn 10 phút; CANCELLED/SUPERSEDED/EXPIRED không tạo mới. UNKNOWN sau kết quả commit không rõ được retry cùng payload/key; PROCESSING qua restart chuyển UNKNOWN, không tự gửi lại mutation. Không hỗ trợ hủy để rollback giao dịch đã bắt đầu. Receipt đã commit có thể replay dù Employee ngừng hoạt động; relation trả về vẫn có thể lỗi nếu query yêu cầu employee.

## 5. SSO, quan sát và giới hạn

- Keycloak realm geo, client synapse; OIDC Authorization Code. Matrix user ánh xạ preferred_username; tên hiển thị lấy name. Bot/admin giữ password login. SSO không tự cấp quyền ghi ticket hay ánh xạ Employee.
- X-API-Key riêng cho Employee/Ticket/GraphQL. MCP hiện chưa có auth riêng; chỉ chạy môi trường local, không public Internet. Guard dùng một user/phòng đã cấu hình, không bảo đảm nhiều user/phòng đồng thời.
- NodeSDK instrumentation cho HTTP, GraphQL, MCP, business và SQLite; W3C propagation, OTLP HTTP/protobuf. Bốn service.name: mcp/graphql/employee-api/ticket-api. JSON logs có otelTraceID/otelSpanID trong context request.
- Không ghi token, key, thông tin cá nhân hoặc SQL parameters vào trace. OpenClaw chưa gửi traceparent nên trace bắt đầu tại MCP. Jaeger memory mất trace khi restart.
- Ngôn ngữ tự nhiên do model diễn giải; guard từ chối khi thiếu bằng chứng, không cam kết hiểu mọi cách nói. Phòng demo không mã hóa đầu cuối; recovery key bảo vệ danh tính/khóa Matrix, không thay mật khẩu Keycloak.
