const infrastructure=new Set(['INTERNAL_ERROR','INTERNAL_SERVER_ERROR','GRAPHQL_ERROR','GRAPHQL_HTTP_ERROR','INVALID_GRAPHQL_RESPONSE','GRAPHQL_TIMEOUT','GRAPHQL_UNAVAILABLE','EMPLOYEE_LOOKUP_FAILED','PREVIEW_FAILED','OUTCOME_UNKNOWN']);
export function errorStatus(code) {
 if(code?.startsWith('UPSTREAM_')||infrastructure.has(code)||!code) return 'unavailable';
 if(['EMPLOYEE_NOT_FOUND','TICKET_NOT_FOUND','DRAFT_NOT_FOUND'].includes(code)) return 'not_found';
 return 'rejected';
}
