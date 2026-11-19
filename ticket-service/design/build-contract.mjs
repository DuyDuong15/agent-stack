// Generates the review contract only; this is not a REST service implementation.
import { writeFileSync } from 'node:fs';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const uuid = () => str({ format: 'uuid' });
const date = () => str({ format: 'date-time' });
const integer = () => ({ type: 'integer', minimum: 0 });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const statuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const priorities = ['LOW', 'MEDIUM', 'HIGH'];
const parameter = (name, schema, description) => ({ name, in: 'query', schema, description });
const paging = [parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'Page size.'), parameter('offset', { type: 'integer', minimum: 0, default: 0 }, 'Zero-based offset.')];
const range = [parameter('createdFrom', date(), 'Inclusive lower bound (UTC or explicit offset).'), parameter('createdTo', date(), 'Exclusive upper bound; must be greater than createdFrom when both supplied.')];
const filters = [parameter('q', str({ minLength: 1, maxLength: 200 }), 'Trimmed, case/accent-insensitive substring of title or description; empty is invalid.'), parameter('code', str({ pattern: '^IT-[0-9]{6,}$' }), 'Exact ticket code.'), parameter('status', str({ enum: statuses }), 'Exact status.'), parameter('priority', str({ enum: priorities }), 'Exact priority.'), parameter('requesterId', uuid(), 'Exact requester ID.'), parameter('assigneeId', uuid(), 'Exact assignee ID; cannot combine with unassigned=true.'), parameter('unassigned', { type: 'boolean' }, 'true: only unassigned; false: only assigned; omit: both.'), parameter('overdue', { type: 'boolean' }, 'true: open/in-progress and dueAt < evaluatedAt. false: complement including resolved, closed and no due date.'), ...range];
const json = schema => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const errors = codes => Object.fromEntries(codes.map(code => [code, { $ref: `#/components/responses/Error${code}` }]));
const get = (operationId, tag, summary, schema, parameters = []) => ({ operationId, tags: [tag], summary, parameters, responses: { 200: response('Success.', schema), ...errors([400, 401, 500]) } });
const page = item => obj({ items: { type: 'array', items: ref(item) }, total: integer(), limit: { type: 'integer', minimum: 1 }, offset: integer() });
const employee = obj({ id: uuid(), code: str({ pattern: '^EMP-[0-9]{3,}$' }), name: str({ minLength: 1, maxLength: 120 }), department: str({ minLength: 1, maxLength: 100 }), active: { type: 'boolean' } });
const ticket = obj({ id: uuid(), code: str({ pattern: '^IT-[0-9]{6,}$' }), title: str({ minLength: 1, maxLength: 200 }), description: str({ minLength: 1, maxLength: 4000 }), requesterId: uuid(), assigneeId: { ...uuid(), nullable: true }, priority: str({ enum: priorities }), status: str({ enum: statuses }), dueAt: { ...date(), nullable: true }, createdAt: date(), updatedAt: date() });
const schemas = {
    Employee: employee, Ticket: ticket, EmployeePage: page('Employee'),
    EmployeeBatch: obj({ items: { type: 'array', items: ref('Employee') }, missingIds: { type: 'array', items: uuid() } }),
    TicketPage: { ...page('Ticket'), properties: { ...page('Ticket').properties, evaluatedAt: date() }, required: [...page('Ticket').required, 'evaluatedAt'] },
    TicketStatistics: obj({ total: integer(), openCount: integer(), overdueCount: integer(), byStatus: obj(Object.fromEntries(statuses.map(s => [s, integer()]))), byPriority: obj(Object.fromEntries(priorities.map(s => [s, integer()]))), evaluatedAt: date() }),
    CreateTicket: obj({ title: str({ minLength: 1, maxLength: 200, description: 'Trim before validation; whitespace-only is invalid.' }), description: str({ minLength: 1, maxLength: 4000, description: 'Trim before validation; whitespace-only is invalid.' }), requesterId: uuid(), assigneeId: { ...uuid(), nullable: true, description: 'Omitted/null means unassigned.' }, priority: str({ enum: priorities }), dueAt: { ...date(), nullable: true, description: 'Omitted/null means no deadline. If present must be later than server creation time.' } }, ['title', 'description', 'requesterId', 'priority']),
    Error: obj({ error: obj({ code: str(), message: str(), details: { type: 'array', items: obj({ field: str(), code: str(), message: str() }, ['code', 'message']) } }, ['code', 'message']), requestId: str() }),
};
const employeeServer = [{ url: 'http://localhost:8011', description: 'Employee API local' }];
const ticketServer = [{ url: 'http://localhost:8012', description: 'Ticket API local' }];
const detail = (kind, tag) => ({ parameters: [{ name: `${kind.toLowerCase()}Id`, in: 'path', required: true, schema: uuid(), description: `${kind} UUID.` }], get: { ...get(`get${kind}`, tag, `Get ${kind.toLowerCase()} by UUID`, ref(kind)), responses: { 200: response('Resource found.', ref(kind)), ...errors([400, 401, 404, 500]) } } });
const paths = {
    '/employees': { servers: employeeServer, get: get('listEmployees', 'Employees', 'Search employees or resolve a batch of IDs', { oneOf: [ref('EmployeePage'), ref('EmployeeBatch')] }, [parameter('q', str({ minLength: 1, maxLength: 120 }), 'Case/accent-insensitive name substring or exact code; trimmed, not blank.'), parameter('department', str({ minLength: 1, maxLength: 100 }), 'Exact case/accent-insensitive department.'), parameter('active', { type: 'boolean' }, 'Omit to include both active and inactive.'), { ...parameter('ids', { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: uuid() }, 'Comma-separated UUIDs. Batch mode forbids q/department/active/limit/offset; returns EmployeeBatch. Missing IDs go in missingIds; found items ordered by code.'), style: 'form', explode: false }, ...paging]) },
    '/employees/{employeeId}': { servers: employeeServer, ...detail('Employee', 'Employees') },
    '/tickets': { servers: ticketServer, get: get('listTickets', 'Tickets', 'Search tickets with pagination', ref('TicketPage'), [...filters, ...paging]) },
    '/tickets/{ticketId}': { servers: ticketServer, ...detail('Ticket', 'Tickets') },
    '/ticket-statistics': { servers: ticketServer, get: get('getTicketStatistics', 'Tickets', 'Aggregate all matching tickets, not just a page', ref('TicketStatistics'), filters) },
};
paths['/employees'].get.description = 'Without ids returns EmployeePage ordered by code ascending. With ids returns EmployeeBatch. Unknown query parameters and incompatible filters return 400. Empty results are 200.';
paths['/tickets'].get.description = 'Combine filters with AND. Sort createdAt descending, then id ascending. total counts all matches; items contains one page. evaluatedAt is a single server timestamp shared by overdue calculations for the request. Unknown query parameters return 400. Empty results are 200.';
paths['/ticket-statistics'].get.description = 'Same filters and semantics as GET /tickets, without pagination. Counts include explicit zeros for every enum value. openCount = OPEN + IN_PROGRESS within the filtered set. overdueCount is overdue tickets within that same set. All counts evaluated from one consistent DB snapshot/time. Unknown query parameters return 400.';
paths['/tickets'].post = {
    operationId: 'createTicket', tags: ['Tickets'], summary: 'Bài 2 — create ticket after user confirmation',
    description: 'REST độc lập, không gọi Employee API. GraphQL kiểm tra nhân viên tồn tại/hoạt động trước khi tạo. Ticket REST kiểm tra payload, deadline, idempotency và trùng nghiệp vụ. Trùng requester + assignee + title (trim/case-insensitive), với ticket OPEN/IN_PROGRESS, trả 409 TICKET_DUPLICATE. Replay cùng key/payload trả ticket cũ trước mọi kiểm tra mới.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: str({ minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }), description: 'Unique per confirmed action; reuse across retries. Scope: service credential + endpoint; retention at least 24h.' }],
    requestBody: { required: true, content: json(ref('CreateTicket')) },
    responses: { 201: { ...response('Created, or replay of previously successful creation.', ref('Ticket')), headers: { Location: { description: 'Relative resource URL /tickets/{ticketId}.', schema: str() }, 'Idempotency-Replayed': { description: 'true for replay; false for first creation.', schema: { type: 'boolean' } } } }, ...errors([400, 401, 409, 500]) },
};
paths['/ticket-replays']={servers:ticketServer,post:{...paths['/tickets'].post,operationId:'lookupTicketReplay',summary:'Tra kết quả idempotency trước khi kiểm tra nhân viên',description:'Không tạo ticket. Cùng key/payload trả kết quả cũ; chưa có key trả ticket null, replayed false; khác payload trả 409.',responses:{200:response('Kết quả tra cứu',obj({ticket:{...ticket,nullable:true},replayed:{type:'boolean'}})),...errors([400,401,409,500])}}};
const descriptions = { 400: 'VALIDATION_ERROR: malformed UUID/date, invalid body/query, incompatible filters or missing idempotency key.', 401: 'UNAUTHORIZED: missing/invalid X-API-Key.', 404: 'EMPLOYEE_NOT_FOUND or TICKET_NOT_FOUND.', 409: 'TICKET_DUPLICATE, IDEMPOTENCY_CONFLICT or REQUEST_IN_PROGRESS. Retry only the latter with the same key/payload.', 500: 'INTERNAL_ERROR: unexpected service failure; no stack trace.' };
const spec = {
    openapi: '3.0.3', info: { title: 'IT Support Ticket — Employee and Ticket APIs', version: '0.3.0', description: 'Implemented onboarding contract: Employee and Ticket REST, including create and replay. Separate services use path-level servers; GraphQL validates employee references before new writes. See ../../SPEC.md for current business rules. HTTP only for local development.', license: { name: 'Private onboarding draft' } },
    servers: ticketServer, tags: [{ name: 'Employees', description: 'Employee lookup and batch resolution; Employee API on port 8011.' }, { name: 'Tickets', description: 'Ticket queries, REST-computed statistics and creation; Ticket API on port 8012.' }], security: [{ ServiceApiKey: [] }], paths,
    components: { securitySchemes: { ServiceApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Service-to-service credential configured in environment. Never embed a real key in this contract.' } }, schemas, responses: Object.fromEntries(Object.entries(descriptions).map(([code, description]) => [`Error${code}`, { ...response(description, ref('Error')), ...(code === '409' ? { headers: { 'Retry-After': { description: 'Seconds to wait for REQUEST_IN_PROGRESS only.', schema: { type: 'integer', minimum: 1 } } } } : {}) }])) },
};
writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n');
console.log('Generated openapi.json (design contract only).');
