export const employeeId = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ticketId = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const statuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
export const priorities = ['LOW', 'MEDIUM', 'HIGH'];
export function fixtures(now = new Date()) {
  const names = ['Nguyễn Văn Nam', 'Trần Văn Nam', 'Lê Thị Hà', 'Đặng Minh Anh', 'Phạm Quang Huy', 'Vũ Thu Trang', 'Hoàng Đức Long', 'Bùi Ngọc Mai'];
  const employees = names.map((name, i) => ({id:employeeId(i+1), code:`EMP-${String(i+1).padStart(3,'0')}`, name, department:['IT','Nhân sự','Kế toán'][i%3], active:i!==7}));
  const iso = delta => new Date(now.getTime()+delta*86400000).toISOString();
  const tickets = Array.from({length:30}, (_,i) => ({id:ticketId(i+1),code:`IT-${String(i+1).padStart(6,'0')}`,title:`${['Máy tính không khởi động','Không kết nối mạng','Cấp quyền phần mềm'][i%3]} #${i+1}`,description:`Yêu cầu hỗ trợ thiết bị và tài khoản số ${i+1}.`,requesterId:employeeId(i%8+1),assigneeId:i%5===0?null:employeeId(i%2+1),priority:priorities[i%3],status:statuses[i%4],dueAt:i%3===0?null:iso(i%3===1?-2:2),createdAt:iso(-30+i),updatedAt:iso(-30+i)}));
  return {employees,tickets};
}
