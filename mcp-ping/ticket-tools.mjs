import {tracedFetch,log} from '../telemetry/index.mjs';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {settings} from '../configuration.mjs';
import {errorStatus} from './tool-status.mjs';
const employeeFields='id code name department active';
const ticketFields=`id code title description status priority dueAt createdAt updatedAt requesterId assigneeId requester{${employeeFields}} assignee{${employeeFields}}`;
const filter=z.object({q:z.string().trim().min(1).max(200).optional(),code:z.string().regex(/^IT-[0-9]{6,}$/).optional(),status:z.enum(['OPEN','IN_PROGRESS','RESOLVED','CLOSED']).optional(),priority:z.enum(['LOW','MEDIUM','HIGH']).optional(),requesterId:z.uuid().optional(),assigneeId:z.uuid().optional(),unassigned:z.boolean().optional(),overdue:z.boolean().optional(),createdFrom:z.string().datetime({offset:true}).optional(),createdTo:z.string().datetime({offset:true}).optional()}).strict();
const pagination=z.object({limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().nonnegative().default(0)}).strict().optional();
const person=z.string().trim().min(1).max(120).describe('Nguyên văn tên hoặc mã nhân viên người dùng chọn. Nếu user chỉ nói Nam, truyền Nam, không tự đổi thành tên đầy đủ/mã/UUID từ lịch sử.');
const personFilter=filter.omit({requesterId:true,assigneeId:true}).extend({requester:person.optional(),assignee:person.optional()}).strict();
export function registerTicketTools(server,{apiKey,url=settings.GRAPHQL_URL,fetchImpl=fetch,timeoutMs=Number(settings.GRAPHQL_TIMEOUT_MS),verifyPersonReference,verifyTicketScope,logger=log}) {
 if(!apiKey) throw new Error('GRAPHQL_API_KEY required');
 const register=(name,description,inputSchema,query)=>server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async variables=>{
   const callId=randomUUID();
   try {
     const appliedFilter={...variables.filter};
     variables={...variables,filter:{...variables.filter}};
     if(['search_tickets','ticket_statistics'].includes(name)) {
       if(verifyTicketScope&&!(await verifyTicketScope(variables.filter))) {
         logger({event:'tool_scope_rejected',tool:name,callId,code:'TICKET_SCOPE_REQUIRED'});
         return {isError:true,content:[{type:'text',text:JSON.stringify({status:'rejected',code:'TICKET_SCOPE_REQUIRED',instruction:'Không được bỏ phạm vi nhân viên để lấy thống kê toàn hệ thống. Đọc lại tin nhắn mới nhất: nếu hỏi Nam, gọi lại với filter.assignee="Nam" (không tự chọn mã). Nếu chưa rõ phạm vi, hỏi lại người dùng. Chỉ lấy toàn hệ thống khi user yêu cầu rõ. Không dùng số liệu cũ để trả lời.'})}]};
       }
       for(const role of ['requester','assignee']) {
         if(variables.filter[role+'Id']) return {isError:true,content:[{type:'text',text:JSON.stringify({status:'rejected',code:'EMPLOYEE_REFERENCE_REQUIRED',instruction:'Không dùng UUID tự chọn. Truyền nguyên văn tên/mã người dùng vào requester/assignee.'})}]};
         const reference=variables.filter[role];if(!reference) continue;
         const lookup=await tracedFetch(fetchImpl,url,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':apiKey},body:JSON.stringify({query:`query($filter:EmployeeFilter){employees(filter:$filter,pagination:{limit:100}){total items{${employeeFields}}}}`,variables:{filter:{q:reference}}}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
         const found=await lookup.json();const page=found?.data?.employees;
         if(found.errors?.length) return {isError:true,content:[{type:'text',text:JSON.stringify({callId,status:found.errors.some(e=>errorStatus(e.extensions?.code)==='unavailable')?'unavailable':'rejected',errors:found.errors.map(e=>({code:e.extensions?.code??'GRAPHQL_ERROR',message:e.message}))})}]};
         if(!lookup.ok||!page||!Array.isArray(page.items)||!Number.isInteger(page.total)) throw new Error('EMPLOYEE_LOOKUP_FAILED');
         if(verifyPersonReference&&!(await verifyPersonReference(reference,page.total===1?page.items[0]:null))) {
           logger({event:'employee_resolution',tool:name,callId,code:'EMPLOYEE_SELECTION_UNCONFIRMED'});
           return {isError:true,content:[{type:'text',text:JSON.stringify({status:'rejected',callId,code:'EMPLOYEE_SELECTION_UNCONFIRMED',instruction:'Tên/mã này KHÔNG có trong tin nhắn mới nhất của người dùng. Không dùng lựa chọn từ câu trả lời cũ của bot. DỪNG và hỏi người dùng chọn mã nhân viên (EMP-001 hoặc EMP-002 nếu là hai người Nam). Không báo số ticket.'})}]};
         }
         if(page.total!==1||page.items.length!==1) {
           const result={callId,code:page.total>1?'EMPLOYEE_AMBIGUOUS':'EMPLOYEE_NOT_FOUND',reference,candidates:page.items,total:page.total,instruction:page.total>1?'DỪNG tra ticket. Hỏi người dùng chọn nhân viên bằng mã/phòng ban. Không tự chọn ứng viên hoặc gọi lại với mã tự suy ra.':'Báo không tìm thấy nhân viên; hỏi lại tên/mã. Không suy đoán số ticket.'};
           logger({event:'employee_resolution',tool:name,callId,code:result.code});
           result.status=page.total>1?'rejected':'not_found';
           return {isError:page.total>1,content:[{type:'text',text:JSON.stringify(result)}]};
         }
         delete variables.filter[role];variables.filter[role+'Id']=page.items[0].id;
       }
     }
     const response=await tracedFetch(fetchImpl,url,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':apiKey},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
     let body;try {body=await response.json();} catch {throw new Error('INVALID_GRAPHQL_RESPONSE');}
     const invalid=!body||typeof body!=='object'||(!Object.hasOwn(body,'data')&&!Array.isArray(body.errors));
     const errors=Array.isArray(body?.errors)?body.errors.map(e=>({code:e.extensions?.code??'GRAPHQL_ERROR',message:'Không lấy được đầy đủ dữ liệu. Không suy đoán phần bị thiếu.',path:e.path,requestId:e.extensions?.requestId})):[];
     if(!response.ok&&!errors.length) errors.push({code:'GRAPHQL_HTTP_ERROR',message:'GraphQL không sẵn sàng.'});
     if(invalid) errors.push({code:'INVALID_GRAPHQL_RESPONSE',message:'GraphQL trả dữ liệu không hợp lệ.'});
     const result={callId,appliedFilter,data:invalid?null:body.data??null,...(errors.length?{errors,instruction:'Chỉ sử dụng dữ liệu còn hợp lệ; nói rõ phần bị lỗi. Không coi lỗi là không có dữ liệu. Không đếm trang để thay thống kê.'}:{})};
     const empty=(name==='get_ticket'&&result.data?.ticket===null)||(name==='search_employees'&&result.data?.employees?.total===0)||(name==='search_tickets'&&result.data?.tickets?.total===0&&!appliedFilter.requester&&!appliedFilter.assignee);
     result.status=errors.length?(errors.some(e=>errorStatus(e.code)==='unavailable')?'unavailable':'rejected'):(empty?'not_found':'ok');
     logger({event:'tool_call',tool:name,callId,status:result.status,graphqlRequestId:response.headers.get('x-request-id'),ok:errors.length===0});
     return {isError:errors.length>0,content:[{type:'text',text:JSON.stringify(result)}]};
   } catch(e) {
     const code=['TimeoutError','AbortError'].includes(e.name)?'GRAPHQL_TIMEOUT':'GRAPHQL_UNAVAILABLE';
     logger({event:'tool_call',tool:name,callId,ok:false,code});
     return {isError:true,content:[{type:'text',text:JSON.stringify({status:'unavailable',callId,errors:[{code,message:'Chưa kết nối được GraphQL. Hãy báo lỗi, không suy đoán dữ liệu.'}]})}]};
   }
 });
 register('search_employees','Tìm nhân viên theo tên/mã/phòng ban. Nếu trùng tên (ví dụ Nam), trình bày mã + phòng ban và hỏi người dùng chọn; không tự chọn người đầu. Dùng UUID đã tra được để lọc ticket.',{filter:z.object({q:z.string().trim().min(1).max(120).optional(),department:z.string().trim().min(1).max(100).optional(),active:z.boolean().optional()}).strict().optional(),pagination},`query($filter:EmployeeFilter,$pagination:PaginationInput!={}){employees(filter:$filter,pagination:$pagination){total limit offset items{${employeeFields}}}}`);
 register('search_tickets','Tra cứu ticket thật và tên người yêu cầu/xử lý. Tìm mã bằng filter.code, người bằng UUID đã xác minh. total là tổng khớp, items chỉ một trang. status OPEN không gồm IN_PROGRESS. overdue do REST tính. Không tự bịa dữ liệu. Ngày tự nhiên dùng Asia/Ho_Chi_Minh rồi truyền ISO có timezone.',{filter:personFilter.optional(),pagination},`query($filter:TicketFilter,$pagination:PaginationInput!={}){tickets(filter:$filter,pagination:$pagination){total limit offset evaluatedAt items{${ticketFields}}}}`);
 register('get_ticket','Xem chi tiết ticket bằng UUID; nếu người dùng đưa mã IT-000001, dùng search_tickets với filter.code trước. null không lỗi nghĩa là không tồn tại.',{id:z.uuid()},`query($id:UUID!){ticket(id:$id){${ticketFields}}}`);
 register('ticket_statistics','Lấy số liệu tổng hợp từ REST qua GraphQL trên TOÀN BỘ tập khớp. Luôn dùng tool này cho câu hỏi bao nhiêu/thống kê, không tự đếm trang. openCount gồm OPEN + IN_PROGRESS. Không truyền status OPEN nếu người dùng muốn tổng đang mở gồm cả đang xử lý.',{filter:personFilter.optional()},'query($filter:TicketFilter){ticketStatistics(filter:$filter){total openCount overdueCount evaluatedAt byStatus{OPEN IN_PROGRESS RESOLVED CLOSED} byPriority{LOW MEDIUM HIGH}}}');
}
