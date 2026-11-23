(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`,"'":`&#39;`};function t(t){return String(t).replace(/[&<>"']/g,t=>e[t]??t)}function n(e){let t=e.trim();if(!t)return null;try{let e=new URL(t);return e.protocol===`http:`||e.protocol===`https:`?e.href:null}catch{return null}}function r(e){e.querySelectorAll(`.upwork-buddy-section-header[data-collapsible="true"]`).forEach(e=>{e.dataset.collapsibleBound!==`true`&&(e.dataset.collapsibleBound=`true`,e.addEventListener(`click`,()=>{let t=e.parentElement?.querySelector(`:scope > .upwork-buddy-section-content`)??e.nextElementSibling,n=e.querySelector(`.upwork-buddy-section-toggle`);t?.classList.toggle(`open`),n?.classList.toggle(`open`)}))})}var i=32;function a(e,n=0){if(e==null)return`<em style="color: #999;">null</em>`;if(n>=i)return typeof e==`object`?`<em style="color: #999;">[Max depth exceeded]</em>`:t(String(e));if(typeof e==`boolean`||typeof e==`number`)return`<strong>${e}</strong>`;if(typeof e==`string`){try{let t=JSON.parse(e);if(typeof t==`object`&&t)return a(t,n)}catch{}return`<p>${t(e).replace(/\n/g,`<br>`)}</p>`}if(Array.isArray(e))return e.length===0?`<em style="color: #999;">Empty array</em>`:`<ul>${e.map(e=>`<li>${a(e,n+1)}</li>`).join(``)}</ul>`;if(typeof e==`object`){let r=``;return Object.entries(e).forEach(([e,i])=>{let o=t(e.replace(/_/g,` `).replace(/\b\w/g,e=>e.toUpperCase()));r+=`
        <div class="upwork-buddy-section" style="margin-left: ${n*10}px;">
          <div class="upwork-buddy-section-header" data-collapsible="true">
            <h4 style="font-size: ${Math.max(11,15-n)}px;">${o}</h4>
            <span class="upwork-buddy-section-toggle">▼</span>
          </div>
          <div class="upwork-buddy-section-content">
            <div class="upwork-buddy-section-body">
              ${a(i,n+1)}
            </div>
          </div>
        </div>
      `}),r}return t(String(e))}function o(e){return typeof e==`string`||Array.isArray(e)?e.length:e&&typeof e==`object`?Object.keys(e).length:0}function s(e,n=!1){console.log(`🎨 renderAnalysis: Starting render with keys:`,Object.keys(e)),console.log(`🎨 renderAnalysis: Field lengths:`,{proposal:e.proposal?.length||0,execution_prompt:e.execution_prompt?.length||0,time_estimate:o(e.time_estimate),workload_division:o(e.workload_division),questions_for_client:o(e.questions_for_client),tips_and_advice:o(e.tips_and_advice),tone_analysis:e.tone_analysis?.length||0});let r=``;n&&e._cached&&(r+=`<div style="background: #fff3cd; color: #856404; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;">
      📦 Loaded from cache (no API call made)
    </div>`);let i={proposal:`📝`,execution_prompt:`⚡`,time_estimate:`⏱️`,workload_division:`🤖`,questions_for_client:`❓`,tips_and_advice:`💡`,tone_analysis:`🎯`},s=[`proposal`,`time_estimate`];return Object.entries(e).forEach(([e,n])=>{if(e.startsWith(`_`))return;console.log(`📄 Rendering section: ${e}`);let o=e.replace(/_/g,` `).replace(/\b\w/g,e=>e.toUpperCase()),c=Object.hasOwn(i,e)?i[e]:`📄`,l=s.includes(e);try{let e=a(n,0);r+=`
        <div class="upwork-buddy-section">
          <div class="upwork-buddy-section-header" data-collapsible="true">
            <h4>${c} ${t(o)}</h4>
            <span class="upwork-buddy-section-toggle ${l?`open`:``}">▼</span>
          </div>
          <div class="upwork-buddy-section-content ${l?`open`:``}">
            <div class="upwork-buddy-section-body">
              ${e}
            </div>
          </div>
        </div>
      `}catch(n){console.error(`❌ Error rendering section ${e}:`,n),r+=`
        <div class="upwork-buddy-section">
          <div class="upwork-buddy-section-header">
            <h4>${c} ${t(o)} (Error)</h4>
          </div>
          <div class="upwork-buddy-section-content open">
            <div class="upwork-buddy-section-body">
              <p style="color: red;">Error rendering this section: ${t(n.message)}</p>
            </div>
          </div>
        </div>
      `}}),r}function c(e){let t=Math.floor((new Date().getTime()-e.getTime())/1e3);return t<60?`just now`:t<3600?`${Math.floor(t/60)} minutes ago`:t<86400?`${Math.floor(t/3600)} hours ago`:t<604800?`${Math.floor(t/86400)} days ago`:e.toLocaleDateString()}function l(){return{accessor:(e,t)=>typeof e==`function`?{...t,accessorFn:e}:{...t,accessorKey:e},display:e=>e,group:e=>e}}function u(e,t){return typeof e==`function`?e(t):e}function d(e,t){return n=>{t.setState(t=>({...t,[e]:u(n,t[e])}))}}function f(e){return e instanceof Function}function p(e){return Array.isArray(e)&&e.every(e=>typeof e==`number`)}function m(e,t){let n=[],r=e=>{e.forEach(e=>{n.push(e);let i=t(e);i!=null&&i.length&&r(i)})};return r(e),n}function h(e,t,n){let r=[],i;return a=>{let o;n.key&&n.debug&&(o=Date.now());let s=e(a);if(!(s.length!==r.length||s.some((e,t)=>r[t]!==e)))return i;r=s;let c;if(n.key&&n.debug&&(c=Date.now()),i=t(...s),n==null||n.onChange==null||n.onChange(i),n.key&&n.debug&&n!=null&&n.debug()){let e=Math.round((Date.now()-o)*100)/100,t=Math.round((Date.now()-c)*100)/100,r=t/16,i=(e,t)=>{for(e=String(e);e.length<t;)e=` `+e;return e};console.info(`%c⏱ ${i(t,5)} /${i(e,5)} ms`,`
            font-size: .6rem;
            font-weight: bold;
            color: hsl(${Math.max(0,Math.min(120-120*r,120))}deg 100% 31%);`,n?.key)}return i}}function g(e,t,n,r){return{debug:()=>e?.debugAll??e[t],key:!1,onChange:r}}function _(e,t,n,r){let i={id:`${t.id}_${n.id}`,row:t,column:n,getValue:()=>t.getValue(r),renderValue:()=>i.getValue()??e.options.renderFallbackValue,getContext:h(()=>[e,n,t,i],(e,t,n,r)=>({table:e,column:t,row:n,cell:r,getValue:r.getValue,renderValue:r.renderValue}),g(e.options,`debugCells`,`cell.getContext`))};return e._features.forEach(r=>{r.createCell==null||r.createCell(i,n,t,e)},{}),i}function ee(e,t,n,r){let i={...e._getDefaultColumnDef(),...t},a=i.accessorKey,o=i.id??(a?typeof String.prototype.replaceAll==`function`?a.replaceAll(`.`,`_`):a.replace(/\./g,`_`):void 0)??(typeof i.header==`string`?i.header:void 0),s;if(i.accessorFn?s=i.accessorFn:a&&(s=a.includes(`.`)?e=>{let t=e;for(let e of a.split(`.`))t=t?.[e];return t}:e=>e[i.accessorKey]),!o)throw Error();let c={id:`${String(o)}`,accessorFn:s,parent:r,depth:n,columnDef:i,columns:[],getFlatColumns:h(()=>[!0],()=>[c,...c.columns?.flatMap(e=>e.getFlatColumns())],g(e.options,`debugColumns`,`column.getFlatColumns`)),getLeafColumns:h(()=>[e._getOrderColumnsFn()],e=>{var t;return(t=c.columns)!=null&&t.length?e(c.columns.flatMap(e=>e.getLeafColumns())):[c]},g(e.options,`debugColumns`,`column.getLeafColumns`))};for(let t of e._features)t.createColumn==null||t.createColumn(c,e);return c}var v=`debugHeaders`;function y(e,t,n){let r={id:n.id??t.id,column:t,index:n.index,isPlaceholder:!!n.isPlaceholder,placeholderId:n.placeholderId,depth:n.depth,subHeaders:[],colSpan:0,rowSpan:0,headerGroup:null,getLeafHeaders:()=>{let e=[],t=n=>{n.subHeaders&&n.subHeaders.length&&n.subHeaders.map(t),e.push(n)};return t(r),e},getContext:()=>({table:e,header:r,column:t})};return e._features.forEach(t=>{t.createHeader==null||t.createHeader(r,e)}),r}var te={createTable:e=>{e.getHeaderGroups=h(()=>[e.getAllColumns(),e.getVisibleLeafColumns(),e.getState().columnPinning.left,e.getState().columnPinning.right],(t,n,r,i)=>{let a=r?.map(e=>n.find(t=>t.id===e)).filter(Boolean)??[],o=i?.map(e=>n.find(t=>t.id===e)).filter(Boolean)??[],s=n.filter(e=>!(r!=null&&r.includes(e.id))&&!(i!=null&&i.includes(e.id)));return b(t,[...a,...s,...o],e)},g(e.options,v,`getHeaderGroups`)),e.getCenterHeaderGroups=h(()=>[e.getAllColumns(),e.getVisibleLeafColumns(),e.getState().columnPinning.left,e.getState().columnPinning.right],(t,n,r,i)=>(n=n.filter(e=>!(r!=null&&r.includes(e.id))&&!(i!=null&&i.includes(e.id))),b(t,n,e,`center`)),g(e.options,v,`getCenterHeaderGroups`)),e.getLeftHeaderGroups=h(()=>[e.getAllColumns(),e.getVisibleLeafColumns(),e.getState().columnPinning.left],(t,n,r)=>b(t,r?.map(e=>n.find(t=>t.id===e)).filter(Boolean)??[],e,`left`),g(e.options,v,`getLeftHeaderGroups`)),e.getRightHeaderGroups=h(()=>[e.getAllColumns(),e.getVisibleLeafColumns(),e.getState().columnPinning.right],(t,n,r)=>b(t,r?.map(e=>n.find(t=>t.id===e)).filter(Boolean)??[],e,`right`),g(e.options,v,`getRightHeaderGroups`)),e.getFooterGroups=h(()=>[e.getHeaderGroups()],e=>[...e].reverse(),g(e.options,v,`getFooterGroups`)),e.getLeftFooterGroups=h(()=>[e.getLeftHeaderGroups()],e=>[...e].reverse(),g(e.options,v,`getLeftFooterGroups`)),e.getCenterFooterGroups=h(()=>[e.getCenterHeaderGroups()],e=>[...e].reverse(),g(e.options,v,`getCenterFooterGroups`)),e.getRightFooterGroups=h(()=>[e.getRightHeaderGroups()],e=>[...e].reverse(),g(e.options,v,`getRightFooterGroups`)),e.getFlatHeaders=h(()=>[e.getHeaderGroups()],e=>e.map(e=>e.headers).flat(),g(e.options,v,`getFlatHeaders`)),e.getLeftFlatHeaders=h(()=>[e.getLeftHeaderGroups()],e=>e.map(e=>e.headers).flat(),g(e.options,v,`getLeftFlatHeaders`)),e.getCenterFlatHeaders=h(()=>[e.getCenterHeaderGroups()],e=>e.map(e=>e.headers).flat(),g(e.options,v,`getCenterFlatHeaders`)),e.getRightFlatHeaders=h(()=>[e.getRightHeaderGroups()],e=>e.map(e=>e.headers).flat(),g(e.options,v,`getRightFlatHeaders`)),e.getCenterLeafHeaders=h(()=>[e.getCenterFlatHeaders()],e=>e.filter(e=>{var t;return!((t=e.subHeaders)!=null&&t.length)}),g(e.options,v,`getCenterLeafHeaders`)),e.getLeftLeafHeaders=h(()=>[e.getLeftFlatHeaders()],e=>e.filter(e=>{var t;return!((t=e.subHeaders)!=null&&t.length)}),g(e.options,v,`getLeftLeafHeaders`)),e.getRightLeafHeaders=h(()=>[e.getRightFlatHeaders()],e=>e.filter(e=>{var t;return!((t=e.subHeaders)!=null&&t.length)}),g(e.options,v,`getRightLeafHeaders`)),e.getLeafHeaders=h(()=>[e.getLeftHeaderGroups(),e.getCenterHeaderGroups(),e.getRightHeaderGroups()],(e,t,n)=>[...e[0]?.headers??[],...t[0]?.headers??[],...n[0]?.headers??[]].map(e=>e.getLeafHeaders()).flat(),g(e.options,v,`getLeafHeaders`))}};function b(e,t,n,r){let i=0,a=function(e,t){t===void 0&&(t=1),i=Math.max(i,t),e.filter(e=>e.getIsVisible()).forEach(e=>{var n;(n=e.columns)!=null&&n.length&&a(e.columns,t+1)},0)};a(e);let o=[],s=(e,t)=>{let i={depth:t,id:[r,`${t}`].filter(Boolean).join(`_`),headers:[]},a=[];e.forEach(e=>{let o=[...a].reverse()[0],s=e.column.depth===i.depth,c,l=!1;if(s&&e.column.parent?c=e.column.parent:(c=e.column,l=!0),o&&o?.column===c)o.subHeaders.push(e);else{let i=y(n,c,{id:[r,t,c.id,e?.id].filter(Boolean).join(`_`),isPlaceholder:l,placeholderId:l?`${a.filter(e=>e.column===c).length}`:void 0,depth:t,index:a.length});i.subHeaders.push(e),a.push(i)}i.headers.push(e),e.headerGroup=i}),o.push(i),t>0&&s(a,t-1)};s(t.map((e,t)=>y(n,e,{depth:i,index:t})),i-1),o.reverse();let c=e=>e.filter(e=>e.column.getIsVisible()).map(e=>{let t=0,n=0,r=[0];e.subHeaders&&e.subHeaders.length?(r=[],c(e.subHeaders).forEach(e=>{let{colSpan:n,rowSpan:i}=e;t+=n,r.push(i)})):t=1;let i=Math.min(...r);return n+=i,e.colSpan=t,e.rowSpan=n,{colSpan:t,rowSpan:n}});return c(o[0]?.headers??[]),o}var x=(e,t,n,r,i,a,o)=>{let s={id:t,index:r,original:n,depth:i,parentId:o,_valuesCache:{},_uniqueValuesCache:{},getValue:t=>{if(s._valuesCache.hasOwnProperty(t))return s._valuesCache[t];let n=e.getColumn(t);if(n!=null&&n.accessorFn)return s._valuesCache[t]=n.accessorFn(s.original,r),s._valuesCache[t]},getUniqueValues:t=>{if(s._uniqueValuesCache.hasOwnProperty(t))return s._uniqueValuesCache[t];let n=e.getColumn(t);if(n!=null&&n.accessorFn)return n.columnDef.getUniqueValues?(s._uniqueValuesCache[t]=n.columnDef.getUniqueValues(s.original,r),s._uniqueValuesCache[t]):(s._uniqueValuesCache[t]=[s.getValue(t)],s._uniqueValuesCache[t])},renderValue:t=>s.getValue(t)??e.options.renderFallbackValue,subRows:a??[],getLeafRows:()=>m(s.subRows,e=>e.subRows),getParentRow:()=>s.parentId?e.getRow(s.parentId,!0):void 0,getParentRows:()=>{let e=[],t=s;for(;;){let n=t.getParentRow();if(!n)break;e.push(n),t=n}return e.reverse()},getAllCells:h(()=>[e.getAllLeafColumns()],t=>t.map(t=>_(e,s,t,t.id)),g(e.options,`debugRows`,`getAllCells`)),_getAllCellsByColumnId:h(()=>[s.getAllCells()],e=>e.reduce((e,t)=>(e[t.column.id]=t,e),{}),g(e.options,`debugRows`,`getAllCellsByColumnId`))};for(let t=0;t<e._features.length;t++){let n=e._features[t];n==null||n.createRow==null||n.createRow(s,e)}return s},ne={createColumn:(e,t)=>{e._getFacetedRowModel=t.options.getFacetedRowModel&&t.options.getFacetedRowModel(t,e.id),e.getFacetedRowModel=()=>e._getFacetedRowModel?e._getFacetedRowModel():t.getPreFilteredRowModel(),e._getFacetedUniqueValues=t.options.getFacetedUniqueValues&&t.options.getFacetedUniqueValues(t,e.id),e.getFacetedUniqueValues=()=>e._getFacetedUniqueValues?e._getFacetedUniqueValues():new Map,e._getFacetedMinMaxValues=t.options.getFacetedMinMaxValues&&t.options.getFacetedMinMaxValues(t,e.id),e.getFacetedMinMaxValues=()=>{if(e._getFacetedMinMaxValues)return e._getFacetedMinMaxValues()}}},S=(e,t,n)=>{var r,i;let a=n==null||(r=n.toString())==null?void 0:r.toLowerCase();return!!((i=e.getValue(t))!=null&&(i=i.toString())!=null&&(i=i.toLowerCase())!=null&&i.includes(a))};S.autoRemove=e=>E(e);var C=(e,t,n)=>{var r;return!!((r=e.getValue(t))!=null&&(r=r.toString())!=null&&r.includes(n))};C.autoRemove=e=>E(e);var re=(e,t,n)=>{var r;return((r=e.getValue(t))==null||(r=r.toString())==null?void 0:r.toLowerCase())===n?.toLowerCase()};re.autoRemove=e=>E(e);var ie=(e,t,n)=>e.getValue(t)?.includes(n);ie.autoRemove=e=>E(e);var ae=(e,t,n)=>!n.some(n=>{var r;return!((r=e.getValue(t))!=null&&r.includes(n))});ae.autoRemove=e=>E(e)||!(e!=null&&e.length);var oe=(e,t,n)=>n.some(n=>e.getValue(t)?.includes(n));oe.autoRemove=e=>E(e)||!(e!=null&&e.length);var se=(e,t,n)=>e.getValue(t)===n;se.autoRemove=e=>E(e);var ce=(e,t,n)=>e.getValue(t)==n;ce.autoRemove=e=>E(e);var w=(e,t,n)=>{let[r,i]=n,a=e.getValue(t);return a>=r&&a<=i};w.resolveFilterValue=e=>{let[t,n]=e,r=typeof t==`number`?t:parseFloat(t),i=typeof n==`number`?n:parseFloat(n),a=t===null||Number.isNaN(r)?-1/0:r,o=n===null||Number.isNaN(i)?1/0:i;if(a>o){let e=a;a=o,o=e}return[a,o]},w.autoRemove=e=>E(e)||E(e[0])&&E(e[1]);var T={includesString:S,includesStringSensitive:C,equalsString:re,arrIncludes:ie,arrIncludesAll:ae,arrIncludesSome:oe,equals:se,weakEquals:ce,inNumberRange:w};function E(e){return e==null||e===``}var le={getDefaultColumnDef:()=>({filterFn:`auto`}),getInitialState:e=>({columnFilters:[],...e}),getDefaultOptions:e=>({onColumnFiltersChange:d(`columnFilters`,e),filterFromLeafRows:!1,maxLeafRowFilterDepth:100}),createColumn:(e,t)=>{e.getAutoFilterFn=()=>{let n=t.getCoreRowModel().flatRows[0]?.getValue(e.id);return typeof n==`string`?T.includesString:typeof n==`number`?T.inNumberRange:typeof n==`boolean`||typeof n==`object`&&n?T.equals:Array.isArray(n)?T.arrIncludes:T.weakEquals},e.getFilterFn=()=>f(e.columnDef.filterFn)?e.columnDef.filterFn:e.columnDef.filterFn===`auto`?e.getAutoFilterFn():t.options.filterFns?.[e.columnDef.filterFn]??T[e.columnDef.filterFn],e.getCanFilter=()=>(e.columnDef.enableColumnFilter??!0)&&(t.options.enableColumnFilters??!0)&&(t.options.enableFilters??!0)&&!!e.accessorFn,e.getIsFiltered=()=>e.getFilterIndex()>-1,e.getFilterValue=()=>{var n;return(n=t.getState().columnFilters)==null||(n=n.find(t=>t.id===e.id))==null?void 0:n.value},e.getFilterIndex=()=>t.getState().columnFilters?.findIndex(t=>t.id===e.id)??-1,e.setFilterValue=n=>{t.setColumnFilters(t=>{let r=e.getFilterFn(),i=t?.find(t=>t.id===e.id),a=u(n,i?i.value:void 0);if(ue(r,a,e))return t?.filter(t=>t.id!==e.id)??[];let o={id:e.id,value:a};return i?t?.map(t=>t.id===e.id?o:t)??[]:t!=null&&t.length?[...t,o]:[o]})}},createRow:(e,t)=>{e.columnFilters={},e.columnFiltersMeta={}},createTable:e=>{e.setColumnFilters=t=>{let n=e.getAllLeafColumns();e.options.onColumnFiltersChange==null||e.options.onColumnFiltersChange(e=>u(t,e)?.filter(e=>{let t=n.find(t=>t.id===e.id);return!(t&&ue(t.getFilterFn(),e.value,t))}))},e.resetColumnFilters=t=>{e.setColumnFilters(t?[]:e.initialState?.columnFilters??[])},e.getPreFilteredRowModel=()=>e.getCoreRowModel(),e.getFilteredRowModel=()=>(!e._getFilteredRowModel&&e.options.getFilteredRowModel&&(e._getFilteredRowModel=e.options.getFilteredRowModel(e)),e.options.manualFiltering||!e._getFilteredRowModel?e.getPreFilteredRowModel():e._getFilteredRowModel())}};function ue(e,t,n){return(e&&e.autoRemove?e.autoRemove(t,n):!1)||t===void 0||typeof t==`string`&&!t}var de={sum:(e,t,n)=>n.reduce((t,n)=>{let r=n.getValue(e);return t+(typeof r==`number`?r:0)},0),min:(e,t,n)=>{let r;return n.forEach(t=>{let n=t.getValue(e);n!=null&&(r>n||r===void 0&&n>=n)&&(r=n)}),r},max:(e,t,n)=>{let r;return n.forEach(t=>{let n=t.getValue(e);n!=null&&(r<n||r===void 0&&n>=n)&&(r=n)}),r},extent:(e,t,n)=>{let r,i;return n.forEach(t=>{let n=t.getValue(e);n!=null&&(r===void 0?n>=n&&(r=i=n):(r>n&&(r=n),i<n&&(i=n)))}),[r,i]},mean:(e,t)=>{let n=0,r=0;if(t.forEach(t=>{let i=t.getValue(e);i!=null&&(i=+i)>=i&&(++n,r+=i)}),n)return r/n},median:(e,t)=>{if(!t.length)return;let n=t.map(t=>t.getValue(e));if(!p(n))return;if(n.length===1)return n[0];let r=Math.floor(n.length/2),i=n.sort((e,t)=>e-t);return n.length%2==0?(i[r-1]+i[r])/2:i[r]},unique:(e,t)=>Array.from(new Set(t.map(t=>t.getValue(e))).values()),uniqueCount:(e,t)=>new Set(t.map(t=>t.getValue(e))).size,count:(e,t)=>t.length},fe={getDefaultColumnDef:()=>({aggregatedCell:e=>{var t;return((t=e.getValue())==null||t.toString==null?void 0:t.toString())??null},aggregationFn:`auto`}),getInitialState:e=>({grouping:[],...e}),getDefaultOptions:e=>({onGroupingChange:d(`grouping`,e),groupedColumnMode:`reorder`}),createColumn:(e,t)=>{e.toggleGrouping=()=>{t.setGrouping(t=>t!=null&&t.includes(e.id)?t.filter(t=>t!==e.id):[...t??[],e.id])},e.getCanGroup=()=>(e.columnDef.enableGrouping??!0)&&(t.options.enableGrouping??!0)&&(!!e.accessorFn||!!e.columnDef.getGroupingValue),e.getIsGrouped=()=>t.getState().grouping?.includes(e.id),e.getGroupedIndex=()=>t.getState().grouping?.indexOf(e.id),e.getToggleGroupingHandler=()=>{let t=e.getCanGroup();return()=>{t&&e.toggleGrouping()}},e.getAutoAggregationFn=()=>{let n=t.getCoreRowModel().flatRows[0]?.getValue(e.id);if(typeof n==`number`)return de.sum;if(Object.prototype.toString.call(n)===`[object Date]`)return de.extent},e.getAggregationFn=()=>{if(!e)throw Error();return f(e.columnDef.aggregationFn)?e.columnDef.aggregationFn:e.columnDef.aggregationFn===`auto`?e.getAutoAggregationFn():t.options.aggregationFns?.[e.columnDef.aggregationFn]??de[e.columnDef.aggregationFn]}},createTable:e=>{e.setGrouping=t=>e.options.onGroupingChange==null?void 0:e.options.onGroupingChange(t),e.resetGrouping=t=>{e.setGrouping(t?[]:e.initialState?.grouping??[])},e.getPreGroupedRowModel=()=>e.getFilteredRowModel(),e.getGroupedRowModel=()=>(!e._getGroupedRowModel&&e.options.getGroupedRowModel&&(e._getGroupedRowModel=e.options.getGroupedRowModel(e)),e.options.manualGrouping||!e._getGroupedRowModel?e.getPreGroupedRowModel():e._getGroupedRowModel())},createRow:(e,t)=>{e.getIsGrouped=()=>!!e.groupingColumnId,e.getGroupingValue=n=>{if(e._groupingValuesCache.hasOwnProperty(n))return e._groupingValuesCache[n];let r=t.getColumn(n);return r!=null&&r.columnDef.getGroupingValue?(e._groupingValuesCache[n]=r.columnDef.getGroupingValue(e.original),e._groupingValuesCache[n]):e.getValue(n)},e._groupingValuesCache={}},createCell:(e,t,n,r)=>{e.getIsGrouped=()=>t.getIsGrouped()&&t.id===n.groupingColumnId,e.getIsPlaceholder=()=>!e.getIsGrouped()&&t.getIsGrouped(),e.getIsAggregated=()=>{var t;return!e.getIsGrouped()&&!e.getIsPlaceholder()&&!!((t=n.subRows)!=null&&t.length)}}};function pe(e,t,n){if(!(t!=null&&t.length)||!n)return e;let r=e.filter(e=>!t.includes(e.id));return n===`remove`?r:[...t.map(t=>e.find(e=>e.id===t)).filter(Boolean),...r]}var me={getInitialState:e=>({columnOrder:[],...e}),getDefaultOptions:e=>({onColumnOrderChange:d(`columnOrder`,e)}),createColumn:(e,t)=>{e.getIndex=h(e=>[k(t,e)],t=>t.findIndex(t=>t.id===e.id),g(t.options,`debugColumns`,`getIndex`)),e.getIsFirstColumn=n=>k(t,n)[0]?.id===e.id,e.getIsLastColumn=n=>{let r=k(t,n);return r[r.length-1]?.id===e.id}},createTable:e=>{e.setColumnOrder=t=>e.options.onColumnOrderChange==null?void 0:e.options.onColumnOrderChange(t),e.resetColumnOrder=t=>{e.setColumnOrder(t?[]:e.initialState.columnOrder??[])},e._getOrderColumnsFn=h(()=>[e.getState().columnOrder,e.getState().grouping,e.options.groupedColumnMode],(e,t,n)=>r=>{let i=[];if(!(e!=null&&e.length))i=r;else{let t=[...e],n=[...r];for(;n.length&&t.length;){let e=t.shift(),r=n.findIndex(t=>t.id===e);r>-1&&i.push(n.splice(r,1)[0])}i=[...i,...n]}return pe(i,t,n)},g(e.options,`debugTable`,`_getOrderColumnsFn`))}},he=()=>({left:[],right:[]}),ge={getInitialState:e=>({columnPinning:he(),...e}),getDefaultOptions:e=>({onColumnPinningChange:d(`columnPinning`,e)}),createColumn:(e,t)=>{e.pin=n=>{let r=e.getLeafColumns().map(e=>e.id).filter(Boolean);t.setColumnPinning(e=>n===`right`?{left:(e?.left??[]).filter(e=>!(r!=null&&r.includes(e))),right:[...(e?.right??[]).filter(e=>!(r!=null&&r.includes(e))),...r]}:n===`left`?{left:[...(e?.left??[]).filter(e=>!(r!=null&&r.includes(e))),...r],right:(e?.right??[]).filter(e=>!(r!=null&&r.includes(e)))}:{left:(e?.left??[]).filter(e=>!(r!=null&&r.includes(e))),right:(e?.right??[]).filter(e=>!(r!=null&&r.includes(e)))})},e.getCanPin=()=>e.getLeafColumns().some(e=>(e.columnDef.enablePinning??!0)&&(t.options.enableColumnPinning??t.options.enablePinning??!0)),e.getIsPinned=()=>{let n=e.getLeafColumns().map(e=>e.id),{left:r,right:i}=t.getState().columnPinning,a=n.some(e=>r?.includes(e)),o=n.some(e=>i?.includes(e));return a?`left`:o?`right`:!1},e.getPinnedIndex=()=>{var n;let r=e.getIsPinned();return r?((n=t.getState().columnPinning)==null||(n=n[r])==null?void 0:n.indexOf(e.id))??-1:0}},createRow:(e,t)=>{e.getCenterVisibleCells=h(()=>[e._getAllVisibleCells(),t.getState().columnPinning.left,t.getState().columnPinning.right],(e,t,n)=>{let r=[...t??[],...n??[]];return e.filter(e=>!r.includes(e.column.id))},g(t.options,`debugRows`,`getCenterVisibleCells`)),e.getLeftVisibleCells=h(()=>[e._getAllVisibleCells(),t.getState().columnPinning.left],(e,t)=>(t??[]).map(t=>e.find(e=>e.column.id===t)).filter(Boolean).map(e=>({...e,position:`left`})),g(t.options,`debugRows`,`getLeftVisibleCells`)),e.getRightVisibleCells=h(()=>[e._getAllVisibleCells(),t.getState().columnPinning.right],(e,t)=>(t??[]).map(t=>e.find(e=>e.column.id===t)).filter(Boolean).map(e=>({...e,position:`right`})),g(t.options,`debugRows`,`getRightVisibleCells`))},createTable:e=>{e.setColumnPinning=t=>e.options.onColumnPinningChange==null?void 0:e.options.onColumnPinningChange(t),e.resetColumnPinning=t=>e.setColumnPinning(t?he():e.initialState?.columnPinning??he()),e.getIsSomeColumnsPinned=t=>{let n=e.getState().columnPinning;return t?!!n[t]?.length:!!(n.left?.length||n.right?.length)},e.getLeftLeafColumns=h(()=>[e.getAllLeafColumns(),e.getState().columnPinning.left],(e,t)=>(t??[]).map(t=>e.find(e=>e.id===t)).filter(Boolean),g(e.options,`debugColumns`,`getLeftLeafColumns`)),e.getRightLeafColumns=h(()=>[e.getAllLeafColumns(),e.getState().columnPinning.right],(e,t)=>(t??[]).map(t=>e.find(e=>e.id===t)).filter(Boolean),g(e.options,`debugColumns`,`getRightLeafColumns`)),e.getCenterLeafColumns=h(()=>[e.getAllLeafColumns(),e.getState().columnPinning.left,e.getState().columnPinning.right],(e,t,n)=>{let r=[...t??[],...n??[]];return e.filter(e=>!r.includes(e.id))},g(e.options,`debugColumns`,`getCenterLeafColumns`))}};function _e(e){return e||(typeof document<`u`?document:null)}var D={size:150,minSize:20,maxSize:2**53-1},ve=()=>({startOffset:null,startSize:null,deltaOffset:null,deltaPercentage:null,isResizingColumn:!1,columnSizingStart:[]}),ye={getDefaultColumnDef:()=>D,getInitialState:e=>({columnSizing:{},columnSizingInfo:ve(),...e}),getDefaultOptions:e=>({columnResizeMode:`onEnd`,columnResizeDirection:`ltr`,onColumnSizingChange:d(`columnSizing`,e),onColumnSizingInfoChange:d(`columnSizingInfo`,e)}),createColumn:(e,t)=>{e.getSize=()=>{let n=t.getState().columnSizing[e.id];return Math.min(Math.max(e.columnDef.minSize??D.minSize,n??e.columnDef.size??D.size),e.columnDef.maxSize??D.maxSize)},e.getStart=h(e=>[e,k(t,e),t.getState().columnSizing],(t,n)=>n.slice(0,e.getIndex(t)).reduce((e,t)=>e+t.getSize(),0),g(t.options,`debugColumns`,`getStart`)),e.getAfter=h(e=>[e,k(t,e),t.getState().columnSizing],(t,n)=>n.slice(e.getIndex(t)+1).reduce((e,t)=>e+t.getSize(),0),g(t.options,`debugColumns`,`getAfter`)),e.resetSize=()=>{t.setColumnSizing(t=>{let{[e.id]:n,...r}=t;return r})},e.getCanResize=()=>(e.columnDef.enableResizing??!0)&&(t.options.enableColumnResizing??!0),e.getIsResizing=()=>t.getState().columnSizingInfo.isResizingColumn===e.id},createHeader:(e,t)=>{e.getSize=()=>{let t=0,n=e=>{e.subHeaders.length?e.subHeaders.forEach(n):t+=e.column.getSize()??0};return n(e),t},e.getStart=()=>{if(e.index>0){let t=e.headerGroup.headers[e.index-1];return t.getStart()+t.getSize()}return 0},e.getResizeHandler=n=>{let r=t.getColumn(e.column.id),i=r?.getCanResize();return a=>{if(!r||!i||(a.persist==null||a.persist(),xe(a)&&a.touches&&a.touches.length>1))return;let o=e.getSize(),s=e?e.getLeafHeaders().map(e=>[e.column.id,e.column.getSize()]):[[r.id,r.getSize()]],c=xe(a)?Math.round(a.touches[0].clientX):a.clientX,l={},u=(e,n)=>{typeof n==`number`&&(t.setColumnSizingInfo(e=>{let r=t.options.columnResizeDirection===`rtl`?-1:1,i=(n-(e?.startOffset??0))*r,a=Math.max(i/(e?.startSize??0),-.999999);return e.columnSizingStart.forEach(e=>{let[t,n]=e;l[t]=Math.round(Math.max(n+n*a,0)*100)/100}),{...e,deltaOffset:i,deltaPercentage:a}}),(t.options.columnResizeMode===`onChange`||e===`end`)&&t.setColumnSizing(e=>({...e,...l})))},d=e=>u(`move`,e),f=e=>{u(`end`,e),t.setColumnSizingInfo(e=>({...e,isResizingColumn:!1,startOffset:null,startSize:null,deltaOffset:null,deltaPercentage:null,columnSizingStart:[]}))},p=_e(n),m={moveHandler:e=>d(e.clientX),upHandler:e=>{p?.removeEventListener(`mousemove`,m.moveHandler),p?.removeEventListener(`mouseup`,m.upHandler),f(e.clientX)}},h={moveHandler:e=>(e.cancelable&&(e.preventDefault(),e.stopPropagation()),d(e.touches[0].clientX),!1),upHandler:e=>{p?.removeEventListener(`touchmove`,h.moveHandler),p?.removeEventListener(`touchend`,h.upHandler),e.cancelable&&(e.preventDefault(),e.stopPropagation()),f(e.touches[0]?.clientX)}},g=be()?{passive:!1}:!1;xe(a)?(p?.addEventListener(`touchmove`,h.moveHandler,g),p?.addEventListener(`touchend`,h.upHandler,g)):(p?.addEventListener(`mousemove`,m.moveHandler,g),p?.addEventListener(`mouseup`,m.upHandler,g)),t.setColumnSizingInfo(e=>({...e,startOffset:c,startSize:o,deltaOffset:0,deltaPercentage:0,columnSizingStart:s,isResizingColumn:r.id}))}}},createTable:e=>{e.setColumnSizing=t=>e.options.onColumnSizingChange==null?void 0:e.options.onColumnSizingChange(t),e.setColumnSizingInfo=t=>e.options.onColumnSizingInfoChange==null?void 0:e.options.onColumnSizingInfoChange(t),e.resetColumnSizing=t=>{e.setColumnSizing(t?{}:e.initialState.columnSizing??{})},e.resetHeaderSizeInfo=t=>{e.setColumnSizingInfo(t?ve():e.initialState.columnSizingInfo??ve())},e.getTotalSize=()=>e.getHeaderGroups()[0]?.headers.reduce((e,t)=>e+t.getSize(),0)??0,e.getLeftTotalSize=()=>e.getLeftHeaderGroups()[0]?.headers.reduce((e,t)=>e+t.getSize(),0)??0,e.getCenterTotalSize=()=>e.getCenterHeaderGroups()[0]?.headers.reduce((e,t)=>e+t.getSize(),0)??0,e.getRightTotalSize=()=>e.getRightHeaderGroups()[0]?.headers.reduce((e,t)=>e+t.getSize(),0)??0}},O=null;function be(){if(typeof O==`boolean`)return O;let e=!1;try{let t={get passive(){return e=!0,!1}},n=()=>{};window.addEventListener(`test`,n,t),window.removeEventListener(`test`,n)}catch{e=!1}return O=e,O}function xe(e){return e.type===`touchstart`}var Se={getInitialState:e=>({columnVisibility:{},...e}),getDefaultOptions:e=>({onColumnVisibilityChange:d(`columnVisibility`,e)}),createColumn:(e,t)=>{e.toggleVisibility=n=>{e.getCanHide()&&t.setColumnVisibility(t=>({...t,[e.id]:n??!e.getIsVisible()}))},e.getIsVisible=()=>{let n=e.columns;return(n.length?n.some(e=>e.getIsVisible()):t.getState().columnVisibility?.[e.id])??!0},e.getCanHide=()=>(e.columnDef.enableHiding??!0)&&(t.options.enableHiding??!0),e.getToggleVisibilityHandler=()=>t=>{e.toggleVisibility==null||e.toggleVisibility(t.target.checked)}},createRow:(e,t)=>{e._getAllVisibleCells=h(()=>[e.getAllCells(),t.getState().columnVisibility],e=>e.filter(e=>e.column.getIsVisible()),g(t.options,`debugRows`,`_getAllVisibleCells`)),e.getVisibleCells=h(()=>[e.getLeftVisibleCells(),e.getCenterVisibleCells(),e.getRightVisibleCells()],(e,t,n)=>[...e,...t,...n],g(t.options,`debugRows`,`getVisibleCells`))},createTable:e=>{let t=(t,n)=>h(()=>[n(),n().filter(e=>e.getIsVisible()).map(e=>e.id).join(`_`)],e=>e.filter(e=>e.getIsVisible==null?void 0:e.getIsVisible()),g(e.options,`debugColumns`,t));e.getVisibleFlatColumns=t(`getVisibleFlatColumns`,()=>e.getAllFlatColumns()),e.getVisibleLeafColumns=t(`getVisibleLeafColumns`,()=>e.getAllLeafColumns()),e.getLeftVisibleLeafColumns=t(`getLeftVisibleLeafColumns`,()=>e.getLeftLeafColumns()),e.getRightVisibleLeafColumns=t(`getRightVisibleLeafColumns`,()=>e.getRightLeafColumns()),e.getCenterVisibleLeafColumns=t(`getCenterVisibleLeafColumns`,()=>e.getCenterLeafColumns()),e.setColumnVisibility=t=>e.options.onColumnVisibilityChange==null?void 0:e.options.onColumnVisibilityChange(t),e.resetColumnVisibility=t=>{e.setColumnVisibility(t?{}:e.initialState.columnVisibility??{})},e.toggleAllColumnsVisible=t=>{t??=!e.getIsAllColumnsVisible(),e.setColumnVisibility(e.getAllLeafColumns().reduce((e,n)=>({...e,[n.id]:t||!(n.getCanHide!=null&&n.getCanHide())}),{}))},e.getIsAllColumnsVisible=()=>!e.getAllLeafColumns().some(e=>!(e.getIsVisible!=null&&e.getIsVisible())),e.getIsSomeColumnsVisible=()=>e.getAllLeafColumns().some(e=>e.getIsVisible==null?void 0:e.getIsVisible()),e.getToggleAllColumnsVisibilityHandler=()=>t=>{e.toggleAllColumnsVisible(t.target?.checked)}}};function k(e,t){return t?t===`center`?e.getCenterVisibleLeafColumns():t===`left`?e.getLeftVisibleLeafColumns():e.getRightVisibleLeafColumns():e.getVisibleLeafColumns()}var Ce={createTable:e=>{e._getGlobalFacetedRowModel=e.options.getFacetedRowModel&&e.options.getFacetedRowModel(e,`__global__`),e.getGlobalFacetedRowModel=()=>e.options.manualFiltering||!e._getGlobalFacetedRowModel?e.getPreFilteredRowModel():e._getGlobalFacetedRowModel(),e._getGlobalFacetedUniqueValues=e.options.getFacetedUniqueValues&&e.options.getFacetedUniqueValues(e,`__global__`),e.getGlobalFacetedUniqueValues=()=>e._getGlobalFacetedUniqueValues?e._getGlobalFacetedUniqueValues():new Map,e._getGlobalFacetedMinMaxValues=e.options.getFacetedMinMaxValues&&e.options.getFacetedMinMaxValues(e,`__global__`),e.getGlobalFacetedMinMaxValues=()=>{if(e._getGlobalFacetedMinMaxValues)return e._getGlobalFacetedMinMaxValues()}}},we={getInitialState:e=>({globalFilter:void 0,...e}),getDefaultOptions:e=>({onGlobalFilterChange:d(`globalFilter`,e),globalFilterFn:`auto`,getColumnCanGlobalFilter:t=>{var n;let r=(n=e.getCoreRowModel().flatRows[0])==null||(n=n._getAllCellsByColumnId()[t.id])==null?void 0:n.getValue();return typeof r==`string`||typeof r==`number`}}),createColumn:(e,t)=>{e.getCanGlobalFilter=()=>(e.columnDef.enableGlobalFilter??!0)&&(t.options.enableGlobalFilter??!0)&&(t.options.enableFilters??!0)&&((t.options.getColumnCanGlobalFilter==null?void 0:t.options.getColumnCanGlobalFilter(e))??!0)&&!!e.accessorFn},createTable:e=>{e.getGlobalAutoFilterFn=()=>T.includesString,e.getGlobalFilterFn=()=>{let{globalFilterFn:t}=e.options;return f(t)?t:t===`auto`?e.getGlobalAutoFilterFn():e.options.filterFns?.[t]??T[t]},e.setGlobalFilter=t=>{e.options.onGlobalFilterChange==null||e.options.onGlobalFilterChange(t)},e.resetGlobalFilter=t=>{e.setGlobalFilter(t?void 0:e.initialState.globalFilter)}}},Te={getInitialState:e=>({expanded:{},...e}),getDefaultOptions:e=>({onExpandedChange:d(`expanded`,e),paginateExpandedRows:!0}),createTable:e=>{let t=!1,n=!1;e._autoResetExpanded=()=>{if(!t)e._queue(()=>{t=!0});else if(e.options.autoResetAll??e.options.autoResetExpanded??!e.options.manualExpanding){if(n)return;n=!0,e._queue(()=>{e.resetExpanded(),n=!1})}},e.setExpanded=t=>e.options.onExpandedChange==null?void 0:e.options.onExpandedChange(t),e.toggleAllRowsExpanded=t=>{t??!e.getIsAllRowsExpanded()?e.setExpanded(!0):e.setExpanded({})},e.resetExpanded=t=>{e.setExpanded(t?{}:e.initialState?.expanded??{})},e.getCanSomeRowsExpand=()=>e.getPrePaginationRowModel().flatRows.some(e=>e.getCanExpand()),e.getToggleAllRowsExpandedHandler=()=>t=>{t.persist==null||t.persist(),e.toggleAllRowsExpanded()},e.getIsSomeRowsExpanded=()=>{let t=e.getState().expanded;return t===!0||Object.values(t).some(Boolean)},e.getIsAllRowsExpanded=()=>{let t=e.getState().expanded;return typeof t==`boolean`?t===!0:!(!Object.keys(t).length||e.getRowModel().flatRows.some(e=>!e.getIsExpanded()))},e.getExpandedDepth=()=>{let t=0;return(e.getState().expanded===!0?Object.keys(e.getRowModel().rowsById):Object.keys(e.getState().expanded)).forEach(e=>{let n=e.split(`.`);t=Math.max(t,n.length)}),t},e.getPreExpandedRowModel=()=>e.getSortedRowModel(),e.getExpandedRowModel=()=>(!e._getExpandedRowModel&&e.options.getExpandedRowModel&&(e._getExpandedRowModel=e.options.getExpandedRowModel(e)),e.options.manualExpanding||!e._getExpandedRowModel?e.getPreExpandedRowModel():e._getExpandedRowModel())},createRow:(e,t)=>{e.toggleExpanded=n=>{t.setExpanded(r=>{let i=r===!0||!!(r!=null&&r[e.id]),a={};if(r===!0?Object.keys(t.getRowModel().rowsById).forEach(e=>{a[e]=!0}):a=r,n??=!i,!i&&n)return{...a,[e.id]:!0};if(i&&!n){let{[e.id]:t,...n}=a;return n}return r})},e.getIsExpanded=()=>{let n=t.getState().expanded;return!!((t.options.getIsRowExpanded==null?void 0:t.options.getIsRowExpanded(e))??(n===!0||n?.[e.id]))},e.getCanExpand=()=>{var n;return(t.options.getRowCanExpand==null?void 0:t.options.getRowCanExpand(e))??((t.options.enableExpanding??!0)&&!!((n=e.subRows)!=null&&n.length))},e.getIsAllParentsExpanded=()=>{let n=!0,r=e;for(;n&&r.parentId;)r=t.getRow(r.parentId,!0),n=r.getIsExpanded();return n},e.getToggleExpandedHandler=()=>{let t=e.getCanExpand();return()=>{t&&e.toggleExpanded()}}}},A=0,j=10,M=()=>({pageIndex:A,pageSize:j}),Ee={getInitialState:e=>({...e,pagination:{...M(),...e?.pagination}}),getDefaultOptions:e=>({onPaginationChange:d(`pagination`,e)}),createTable:e=>{let t=!1,n=!1;e._autoResetPageIndex=()=>{if(!t)e._queue(()=>{t=!0});else if(e.options.autoResetAll??e.options.autoResetPageIndex??!e.options.manualPagination){if(n)return;n=!0,e._queue(()=>{e.resetPageIndex(),n=!1})}},e.setPagination=t=>e.options.onPaginationChange==null?void 0:e.options.onPaginationChange(e=>u(t,e)),e.resetPagination=t=>{e.setPagination(t?M():e.initialState.pagination??M())},e.setPageIndex=t=>{e.setPagination(n=>{let r=u(t,n.pageIndex),i=e.options.pageCount===void 0||e.options.pageCount===-1?2**53-1:e.options.pageCount-1;return r=Math.max(0,Math.min(r,i)),{...n,pageIndex:r}})},e.resetPageIndex=t=>{var n;e.setPageIndex(t?A:((n=e.initialState)==null||(n=n.pagination)==null?void 0:n.pageIndex)??A)},e.resetPageSize=t=>{var n;e.setPageSize(t?j:((n=e.initialState)==null||(n=n.pagination)==null?void 0:n.pageSize)??j)},e.setPageSize=t=>{e.setPagination(e=>{let n=Math.max(1,u(t,e.pageSize)),r=e.pageSize*e.pageIndex,i=Math.floor(r/n);return{...e,pageIndex:i,pageSize:n}})},e.setPageCount=t=>e.setPagination(n=>{let r=u(t,e.options.pageCount??-1);return typeof r==`number`&&(r=Math.max(-1,r)),{...n,pageCount:r}}),e.getPageOptions=h(()=>[e.getPageCount()],e=>{let t=[];return e&&e>0&&(t=[...Array(e)].fill(null).map((e,t)=>t)),t},g(e.options,`debugTable`,`getPageOptions`)),e.getCanPreviousPage=()=>e.getState().pagination.pageIndex>0,e.getCanNextPage=()=>{let{pageIndex:t}=e.getState().pagination,n=e.getPageCount();return n===-1||n!==0&&t<n-1},e.previousPage=()=>e.setPageIndex(e=>e-1),e.nextPage=()=>e.setPageIndex(e=>e+1),e.firstPage=()=>e.setPageIndex(0),e.lastPage=()=>e.setPageIndex(e.getPageCount()-1),e.getPrePaginationRowModel=()=>e.getExpandedRowModel(),e.getPaginationRowModel=()=>(!e._getPaginationRowModel&&e.options.getPaginationRowModel&&(e._getPaginationRowModel=e.options.getPaginationRowModel(e)),e.options.manualPagination||!e._getPaginationRowModel?e.getPrePaginationRowModel():e._getPaginationRowModel()),e.getPageCount=()=>e.options.pageCount??Math.ceil(e.getRowCount()/e.getState().pagination.pageSize),e.getRowCount=()=>e.options.rowCount??e.getPrePaginationRowModel().rows.length}},N=()=>({top:[],bottom:[]}),De={getInitialState:e=>({rowPinning:N(),...e}),getDefaultOptions:e=>({onRowPinningChange:d(`rowPinning`,e)}),createRow:(e,t)=>{e.pin=(n,r,i)=>{let a=r?e.getLeafRows().map(e=>{let{id:t}=e;return t}):[],o=i?e.getParentRows().map(e=>{let{id:t}=e;return t}):[],s=new Set([...o,e.id,...a]);t.setRowPinning(e=>n===`bottom`?{top:(e?.top??[]).filter(e=>!(s!=null&&s.has(e))),bottom:[...(e?.bottom??[]).filter(e=>!(s!=null&&s.has(e))),...Array.from(s)]}:n===`top`?{top:[...(e?.top??[]).filter(e=>!(s!=null&&s.has(e))),...Array.from(s)],bottom:(e?.bottom??[]).filter(e=>!(s!=null&&s.has(e)))}:{top:(e?.top??[]).filter(e=>!(s!=null&&s.has(e))),bottom:(e?.bottom??[]).filter(e=>!(s!=null&&s.has(e)))})},e.getCanPin=()=>{let{enableRowPinning:n,enablePinning:r}=t.options;return typeof n==`function`?n(e):n??r??!0},e.getIsPinned=()=>{let n=[e.id],{top:r,bottom:i}=t.getState().rowPinning,a=n.some(e=>r?.includes(e)),o=n.some(e=>i?.includes(e));return a?`top`:o?`bottom`:!1},e.getPinnedIndex=()=>{let n=e.getIsPinned();return n?((n===`top`?t.getTopRows():t.getBottomRows())?.map(e=>{let{id:t}=e;return t}))?.indexOf(e.id)??-1:-1}},createTable:e=>{e.setRowPinning=t=>e.options.onRowPinningChange==null?void 0:e.options.onRowPinningChange(t),e.resetRowPinning=t=>e.setRowPinning(t?N():e.initialState?.rowPinning??N()),e.getIsSomeRowsPinned=t=>{let n=e.getState().rowPinning;return t?!!n[t]?.length:!!(n.top?.length||n.bottom?.length)},e._getPinnedRows=(t,n,r)=>(e.options.keepPinnedRows??!0?(n??[]).map(t=>{let n=e.getRow(t,!0);return n.getIsAllParentsExpanded()?n:null}):(n??[]).map(e=>t.find(t=>t.id===e))).filter(Boolean).map(e=>({...e,position:r})),e.getTopRows=h(()=>[e.getRowModel().rows,e.getState().rowPinning.top],(t,n)=>e._getPinnedRows(t,n,`top`),g(e.options,`debugRows`,`getTopRows`)),e.getBottomRows=h(()=>[e.getRowModel().rows,e.getState().rowPinning.bottom],(t,n)=>e._getPinnedRows(t,n,`bottom`),g(e.options,`debugRows`,`getBottomRows`)),e.getCenterRows=h(()=>[e.getRowModel().rows,e.getState().rowPinning.top,e.getState().rowPinning.bottom],(e,t,n)=>{let r=new Set([...t??[],...n??[]]);return e.filter(e=>!r.has(e.id))},g(e.options,`debugRows`,`getCenterRows`))}},Oe={getInitialState:e=>({rowSelection:{},...e}),getDefaultOptions:e=>({onRowSelectionChange:d(`rowSelection`,e),enableRowSelection:!0,enableMultiRowSelection:!0,enableSubRowSelection:!0}),createTable:e=>{e.setRowSelection=t=>e.options.onRowSelectionChange==null?void 0:e.options.onRowSelectionChange(t),e.resetRowSelection=t=>e.setRowSelection(t?{}:e.initialState.rowSelection??{}),e.toggleAllRowsSelected=t=>{e.setRowSelection(n=>{t=t===void 0?!e.getIsAllRowsSelected():t;let r={...n},i=e.getPreGroupedRowModel().flatRows;return t?i.forEach(e=>{e.getCanSelect()&&(r[e.id]=!0)}):i.forEach(e=>{delete r[e.id]}),r})},e.toggleAllPageRowsSelected=t=>e.setRowSelection(n=>{let r=t===void 0?!e.getIsAllPageRowsSelected():t,i={...n};return e.getRowModel().rows.forEach(t=>{P(i,t.id,r,!0,e)}),i}),e.getPreSelectedRowModel=()=>e.getCoreRowModel(),e.getSelectedRowModel=h(()=>[e.getState().rowSelection,e.getCoreRowModel()],(t,n)=>Object.keys(t).length?F(e,n):{rows:[],flatRows:[],rowsById:{}},g(e.options,`debugTable`,`getSelectedRowModel`)),e.getFilteredSelectedRowModel=h(()=>[e.getState().rowSelection,e.getFilteredRowModel()],(t,n)=>Object.keys(t).length?F(e,n):{rows:[],flatRows:[],rowsById:{}},g(e.options,`debugTable`,`getFilteredSelectedRowModel`)),e.getGroupedSelectedRowModel=h(()=>[e.getState().rowSelection,e.getSortedRowModel()],(t,n)=>Object.keys(t).length?F(e,n):{rows:[],flatRows:[],rowsById:{}},g(e.options,`debugTable`,`getGroupedSelectedRowModel`)),e.getIsAllRowsSelected=()=>{let t=e.getFilteredRowModel().flatRows,{rowSelection:n}=e.getState(),r=!!(t.length&&Object.keys(n).length);return r&&t.some(e=>e.getCanSelect()&&!n[e.id])&&(r=!1),r},e.getIsAllPageRowsSelected=()=>{let t=e.getPaginationRowModel().flatRows.filter(e=>e.getCanSelect()),{rowSelection:n}=e.getState(),r=!!t.length;return r&&t.some(e=>!n[e.id])&&(r=!1),r},e.getIsSomeRowsSelected=()=>{let t=Object.keys(e.getState().rowSelection??{}).length;return t>0&&t<e.getFilteredRowModel().flatRows.length},e.getIsSomePageRowsSelected=()=>{let t=e.getPaginationRowModel().flatRows;return!e.getIsAllPageRowsSelected()&&t.filter(e=>e.getCanSelect()).some(e=>e.getIsSelected()||e.getIsSomeSelected())},e.getToggleAllRowsSelectedHandler=()=>t=>{e.toggleAllRowsSelected(t.target.checked)},e.getToggleAllPageRowsSelectedHandler=()=>t=>{e.toggleAllPageRowsSelected(t.target.checked)}},createRow:(e,t)=>{e.toggleSelected=(n,r)=>{let i=e.getIsSelected();t.setRowSelection(a=>{if(n=n===void 0?!i:n,e.getCanSelect()&&i===n)return a;let o={...a};return P(o,e.id,n,r?.selectChildren??!0,t),o})},e.getIsSelected=()=>{let{rowSelection:n}=t.getState();return I(e,n)},e.getIsSomeSelected=()=>{let{rowSelection:n}=t.getState();return L(e,n)===`some`},e.getIsAllSubRowsSelected=()=>{let{rowSelection:n}=t.getState();return L(e,n)===`all`},e.getCanSelect=()=>typeof t.options.enableRowSelection==`function`?t.options.enableRowSelection(e):t.options.enableRowSelection??!0,e.getCanSelectSubRows=()=>typeof t.options.enableSubRowSelection==`function`?t.options.enableSubRowSelection(e):t.options.enableSubRowSelection??!0,e.getCanMultiSelect=()=>typeof t.options.enableMultiRowSelection==`function`?t.options.enableMultiRowSelection(e):t.options.enableMultiRowSelection??!0,e.getToggleSelectedHandler=()=>{let t=e.getCanSelect();return n=>{t&&e.toggleSelected(n.target?.checked)}}}},P=(e,t,n,r,i)=>{var a;let o=i.getRow(t,!0);n?(o.getCanMultiSelect()||Object.keys(e).forEach(t=>delete e[t]),o.getCanSelect()&&(e[t]=!0)):delete e[t],r&&(a=o.subRows)!=null&&a.length&&o.getCanSelectSubRows()&&o.subRows.forEach(t=>P(e,t.id,n,r,i))};function F(e,t){let n=e.getState().rowSelection,r=[],i={},a=function(e,t){return e.map(e=>{var t;let o=I(e,n);if(o&&(r.push(e),i[e.id]=e),(t=e.subRows)!=null&&t.length&&(e={...e,subRows:a(e.subRows)}),o)return e}).filter(Boolean)};return{rows:a(t.rows),flatRows:r,rowsById:i}}function I(e,t){return t[e.id]??!1}function L(e,t,n){var r;if(!((r=e.subRows)!=null&&r.length))return!1;let i=!0,a=!1;return e.subRows.forEach(e=>{if((!a||i)&&(e.getCanSelect()&&(I(e,t)?a=!0:i=!1),e.subRows&&e.subRows.length)){let n=L(e,t);n===`all`?a=!0:(n===`some`&&(a=!0),i=!1)}}),i?`all`:a?`some`:!1}var R=/([0-9]+)/gm,ke=(e,t,n)=>Fe(B(e.getValue(n)).toLowerCase(),B(t.getValue(n)).toLowerCase()),Ae=(e,t,n)=>Fe(B(e.getValue(n)),B(t.getValue(n))),je=(e,t,n)=>z(B(e.getValue(n)).toLowerCase(),B(t.getValue(n)).toLowerCase()),Me=(e,t,n)=>z(B(e.getValue(n)),B(t.getValue(n))),Ne=(e,t,n)=>{let r=e.getValue(n),i=t.getValue(n);return r>i?1:r<i?-1:0},Pe=(e,t,n)=>z(e.getValue(n),t.getValue(n));function z(e,t){return e===t?0:e>t?1:-1}function B(e){return typeof e==`number`?isNaN(e)||e===1/0||e===-1/0?``:String(e):typeof e==`string`?e:``}function Fe(e,t){let n=e.split(R).filter(Boolean),r=t.split(R).filter(Boolean);for(;n.length&&r.length;){let e=n.shift(),t=r.shift(),i=parseInt(e,10),a=parseInt(t,10),o=[i,a].sort();if(isNaN(o[0])){if(e>t)return 1;if(t>e)return-1}else{if(isNaN(o[1]))return isNaN(i)?-1:1;if(i>a)return 1;if(a>i)return-1}}return n.length-r.length}var V={alphanumeric:ke,alphanumericCaseSensitive:Ae,text:je,textCaseSensitive:Me,datetime:Ne,basic:Pe},Ie=[te,Se,me,ge,ne,le,Ce,we,{getInitialState:e=>({sorting:[],...e}),getDefaultColumnDef:()=>({sortingFn:`auto`,sortUndefined:1}),getDefaultOptions:e=>({onSortingChange:d(`sorting`,e),isMultiSortEvent:e=>e.shiftKey}),createColumn:(e,t)=>{e.getAutoSortingFn=()=>{let n=t.getFilteredRowModel().flatRows.slice(10),r=!1;for(let t of n){let n=t?.getValue(e.id);if(Object.prototype.toString.call(n)===`[object Date]`)return V.datetime;if(typeof n==`string`&&(r=!0,n.split(R).length>1))return V.alphanumeric}return r?V.text:V.basic},e.getAutoSortDir=()=>typeof t.getFilteredRowModel().flatRows[0]?.getValue(e.id)==`string`?`asc`:`desc`,e.getSortingFn=()=>{if(!e)throw Error();return f(e.columnDef.sortingFn)?e.columnDef.sortingFn:e.columnDef.sortingFn===`auto`?e.getAutoSortingFn():t.options.sortingFns?.[e.columnDef.sortingFn]??V[e.columnDef.sortingFn]},e.toggleSorting=(n,r)=>{let i=e.getNextSortingOrder(),a=n!=null;t.setSorting(o=>{let s=o?.find(t=>t.id===e.id),c=o?.findIndex(t=>t.id===e.id),l=[],u,d=a?n:i===`desc`;return u=o!=null&&o.length&&e.getCanMultiSort()&&r?s?`toggle`:`add`:o!=null&&o.length&&c!==o.length-1?`replace`:s?`toggle`:`replace`,u===`toggle`&&(a||i||(u=`remove`)),u===`add`?(l=[...o,{id:e.id,desc:d}],l.splice(0,l.length-(t.options.maxMultiSortColCount??2**53-1))):l=u===`toggle`?o.map(t=>t.id===e.id?{...t,desc:d}:t):u===`remove`?o.filter(t=>t.id!==e.id):[{id:e.id,desc:d}],l})},e.getFirstSortDir=()=>e.columnDef.sortDescFirst??t.options.sortDescFirst??e.getAutoSortDir()===`desc`?`desc`:`asc`,e.getNextSortingOrder=n=>{let r=e.getFirstSortDir(),i=e.getIsSorted();return i?i!==r&&(t.options.enableSortingRemoval??!0)&&(!n||(t.options.enableMultiRemove??!0))?!1:i===`desc`?`asc`:`desc`:r},e.getCanSort=()=>(e.columnDef.enableSorting??!0)&&(t.options.enableSorting??!0)&&!!e.accessorFn,e.getCanMultiSort=()=>e.columnDef.enableMultiSort??t.options.enableMultiSort??!!e.accessorFn,e.getIsSorted=()=>{let n=t.getState().sorting?.find(t=>t.id===e.id);return n?n.desc?`desc`:`asc`:!1},e.getSortIndex=()=>t.getState().sorting?.findIndex(t=>t.id===e.id)??-1,e.clearSorting=()=>{t.setSorting(t=>t!=null&&t.length?t.filter(t=>t.id!==e.id):[])},e.getToggleSortingHandler=()=>{let n=e.getCanSort();return r=>{n&&(r.persist==null||r.persist(),e.toggleSorting==null||e.toggleSorting(void 0,e.getCanMultiSort()?t.options.isMultiSortEvent==null?void 0:t.options.isMultiSortEvent(r):!1))}}},createTable:e=>{e.setSorting=t=>e.options.onSortingChange==null?void 0:e.options.onSortingChange(t),e.resetSorting=t=>{e.setSorting(t?[]:e.initialState?.sorting??[])},e.getPreSortedRowModel=()=>e.getGroupedRowModel(),e.getSortedRowModel=()=>(!e._getSortedRowModel&&e.options.getSortedRowModel&&(e._getSortedRowModel=e.options.getSortedRowModel(e)),e.options.manualSorting||!e._getSortedRowModel?e.getPreSortedRowModel():e._getSortedRowModel())}},fe,Te,Ee,De,Oe,ye];function Le(e){let t=[...Ie,...e._features??[]],n={_features:t},r=n._features.reduce((e,t)=>Object.assign(e,t.getDefaultOptions==null?void 0:t.getDefaultOptions(n)),{}),i=e=>n.options.mergeOptions?n.options.mergeOptions(r,e):{...r,...e},a={...e.initialState??{}};n._features.forEach(e=>{a=(e.getInitialState==null?void 0:e.getInitialState(a))??a});let o=[],s=!1,c={_features:t,options:{...r,...e},initialState:a,_queue:e=>{o.push(e),s||(s=!0,Promise.resolve().then(()=>{for(;o.length;)o.shift()();s=!1}).catch(e=>setTimeout(()=>{throw e})))},reset:()=>{n.setState(n.initialState)},setOptions:e=>{let t=u(e,n.options);n.options=i(t)},getState:()=>n.options.state,setState:e=>{n.options.onStateChange==null||n.options.onStateChange(e)},_getRowId:(e,t,r)=>(n.options.getRowId==null?void 0:n.options.getRowId(e,t,r))??`${r?[r.id,t].join(`.`):t}`,getCoreRowModel:()=>(n._getCoreRowModel||=n.options.getCoreRowModel(n),n._getCoreRowModel()),getRowModel:()=>n.getPaginationRowModel(),getRow:(e,t)=>{let r=(t?n.getPrePaginationRowModel():n.getRowModel()).rowsById[e];if(!r&&(r=n.getCoreRowModel().rowsById[e],!r))throw Error();return r},_getDefaultColumnDef:h(()=>[n.options.defaultColumn],e=>(e??={},{header:e=>{let t=e.header.column.columnDef;return t.accessorKey?t.accessorKey:t.accessorFn?t.id:null},cell:e=>{var t;return((t=e.renderValue())==null||t.toString==null?void 0:t.toString())??null},...n._features.reduce((e,t)=>Object.assign(e,t.getDefaultColumnDef==null?void 0:t.getDefaultColumnDef()),{}),...e}),g(e,`debugColumns`,`_getDefaultColumnDef`)),_getColumnDefs:()=>n.options.columns,getAllColumns:h(()=>[n._getColumnDefs()],e=>{let t=function(e,r,i){return i===void 0&&(i=0),e.map(e=>{let a=ee(n,e,i,r),o=e;return a.columns=o.columns?t(o.columns,a,i+1):[],a})};return t(e)},g(e,`debugColumns`,`getAllColumns`)),getAllFlatColumns:h(()=>[n.getAllColumns()],e=>e.flatMap(e=>e.getFlatColumns()),g(e,`debugColumns`,`getAllFlatColumns`)),_getAllFlatColumnsById:h(()=>[n.getAllFlatColumns()],e=>e.reduce((e,t)=>(e[t.id]=t,e),{}),g(e,`debugColumns`,`getAllFlatColumnsById`)),getAllLeafColumns:h(()=>[n.getAllColumns(),n._getOrderColumnsFn()],(e,t)=>t(e.flatMap(e=>e.getLeafColumns())),g(e,`debugColumns`,`getAllLeafColumns`)),getColumn:e=>n._getAllFlatColumnsById()[e]};Object.assign(n,c);for(let e=0;e<n._features.length;e++){let t=n._features[e];t==null||t.createTable==null||t.createTable(n)}return n}function Re(){return e=>h(()=>[e.options.data],t=>{let n={rows:[],flatRows:[],rowsById:{}},r=function(t,i,a){i===void 0&&(i=0);let o=[];for(let c=0;c<t.length;c++){let l=x(e,e._getRowId(t[c],c,a),t[c],c,i,void 0,a?.id);if(n.flatRows.push(l),n.rowsById[l.id]=l,o.push(l),e.options.getSubRows){var s;l.originalSubRows=e.options.getSubRows(t[c],c),(s=l.originalSubRows)!=null&&s.length&&(l.subRows=r(l.originalSubRows,i+1,l))}}return o};return n.rows=r(t),n},g(e.options,`debugTable`,`getRowModel`,()=>e._autoResetPageIndex()))}function ze(e){let t=[],n=e=>{var r;t.push(e),(r=e.subRows)!=null&&r.length&&e.getIsExpanded()&&e.subRows.forEach(n)};return e.rows.forEach(n),{rows:t,flatRows:e.flatRows,rowsById:e.rowsById}}function Be(e,t,n){return n.options.filterFromLeafRows?Ve(e,t,n):He(e,t,n)}function Ve(e,t,n){let r=[],i={},a=n.options.maxLeafRowFilterDepth??100,o=function(e,s){s===void 0&&(s=0);let c=[];for(let u=0;u<e.length;u++){var l;let d=e[u],f=x(n,d.id,d.original,d.index,d.depth,void 0,d.parentId);if(f.columnFilters=d.columnFilters,(l=d.subRows)!=null&&l.length&&s<a){if(f.subRows=o(d.subRows,s+1),d=f,t(d)&&!f.subRows.length||t(d)||f.subRows.length){c.push(d),i[d.id]=d,r.push(d);continue}}else d=f,t(d)&&(c.push(d),i[d.id]=d,r.push(d))}return c};return{rows:o(e),flatRows:r,rowsById:i}}function He(e,t,n){let r=[],i={},a=n.options.maxLeafRowFilterDepth??100,o=function(e,s){s===void 0&&(s=0);let c=[];for(let u=0;u<e.length;u++){let d=e[u];if(t(d)){var l;if((l=d.subRows)!=null&&l.length&&s<a){let e=x(n,d.id,d.original,d.index,d.depth,void 0,d.parentId);e.subRows=o(d.subRows,s+1),d=e}c.push(d),r.push(d),i[d.id]=d}}return c};return{rows:o(e),flatRows:r,rowsById:i}}function Ue(){return e=>h(()=>[e.getPreFilteredRowModel(),e.getState().columnFilters,e.getState().globalFilter],(t,n,r)=>{if(!t.rows.length||!(n!=null&&n.length)&&!r){for(let e=0;e<t.flatRows.length;e++)t.flatRows[e].columnFilters={},t.flatRows[e].columnFiltersMeta={};return t}let i=[],a=[];(n??[]).forEach(t=>{let n=e.getColumn(t.id);if(!n)return;let r=n.getFilterFn();r&&i.push({id:t.id,filterFn:r,resolvedValue:(r.resolveFilterValue==null?void 0:r.resolveFilterValue(t.value))??t.value})});let o=(n??[]).map(e=>e.id),s=e.getGlobalFilterFn(),c=e.getAllLeafColumns().filter(e=>e.getCanGlobalFilter());r&&s&&c.length&&(o.push(`__global__`),c.forEach(e=>{a.push({id:e.id,filterFn:s,resolvedValue:(s.resolveFilterValue==null?void 0:s.resolveFilterValue(r))??r})}));let l,u;for(let e=0;e<t.flatRows.length;e++){let n=t.flatRows[e];if(n.columnFilters={},i.length)for(let e=0;e<i.length;e++){l=i[e];let t=l.id;n.columnFilters[t]=l.filterFn(n,t,l.resolvedValue,e=>{n.columnFiltersMeta[t]=e})}if(a.length){for(let e=0;e<a.length;e++){u=a[e];let t=u.id;if(u.filterFn(n,t,u.resolvedValue,e=>{n.columnFiltersMeta[t]=e})){n.columnFilters.__global__=!0;break}}n.columnFilters.__global__!==!0&&(n.columnFilters.__global__=!1)}}return Be(t.rows,e=>{for(let t=0;t<o.length;t++)if(e.columnFilters[o[t]]===!1)return!1;return!0},e)},g(e.options,`debugTable`,`getFilteredRowModel`,()=>e._autoResetPageIndex()))}function We(e){return e=>h(()=>[e.getState().pagination,e.getPrePaginationRowModel(),e.options.paginateExpandedRows?void 0:e.getState().expanded],(t,n)=>{if(!n.rows.length)return n;let{pageSize:r,pageIndex:i}=t,{rows:a,flatRows:o,rowsById:s}=n,c=r*i,l=c+r;a=a.slice(c,l);let u;u=e.options.paginateExpandedRows?{rows:a,flatRows:o,rowsById:s}:ze({rows:a,flatRows:o,rowsById:s}),u.flatRows=[];let d=e=>{u.flatRows.push(e),e.subRows.length&&e.subRows.forEach(d)};return u.rows.forEach(d),u},g(e.options,`debugTable`,`getPaginationRowModel`))}function Ge(){return e=>h(()=>[e.getState().sorting,e.getPreSortedRowModel()],(t,n)=>{if(!n.rows.length||!(t!=null&&t.length))return n;let r=e.getState().sorting,i=[],a=r.filter(t=>e.getColumn(t.id)?.getCanSort()),o={};a.forEach(t=>{let n=e.getColumn(t.id);n&&(o[t.id]={sortUndefined:n.columnDef.sortUndefined,invertSorting:n.columnDef.invertSorting,sortingFn:n.getSortingFn()})});let s=e=>{let t=e.map(e=>({...e}));return t.sort((e,t)=>{for(let n=0;n<a.length;n+=1){let r=a[n],i=o[r.id],s=i.sortUndefined,c=r?.desc??!1,l=0;if(s){let n=e.getValue(r.id),i=t.getValue(r.id),a=n===void 0,o=i===void 0;if(a||o){if(s===`first`)return a?-1:1;if(s===`last`)return a?1:-1;l=a&&o?0:a?s:-s}}if(l===0&&(l=i.sortingFn(e,t,r.id)),l!==0)return c&&(l*=-1),i.invertSorting&&(l*=-1),l}return e.index-t.index}),t.forEach(e=>{var t;i.push(e),(t=e.subRows)!=null&&t.length&&(e.subRows=s(e.subRows))}),t};return{rows:s(n.rows),flatRows:i,rowsById:n.rowsById}},g(e.options,`debugTable`,`getSortedRowModel`,()=>e._autoResetPageIndex()))}function H(e){let t=(e.ai_enrichment_status??`none`).toLowerCase();if(t===`queued`)return{key:`queued`,label:`Queued`,tone:`info`,tooltip:`Queued for AI enrichment`};if(t===`scraping_details`)return{key:`scraping_details`,label:`Scraping Details...`,tone:`info`,tooltip:`Fetching full Upwork job details via Chrome`};if(t===`analyzing`)return{key:`analyzing`,label:`Analyzing...`,tone:`info`,tooltip:`Running AI analysis`};if(t===`failed`)return{key:`failed`,label:`Failed`,tone:`danger`,tooltip:e.ai_enrichment_error||`Enrichment failed`};if(t===`completed`||e.ai_enriched_at||e.proposal?.trim()){let t=[];return e.ai_model&&t.push(e.ai_model),e.ai_effort&&t.push(`effort: ${e.ai_effort}`),typeof e.ai_tokens_used==`number`&&Number.isFinite(e.ai_tokens_used)&&t.push(`${e.ai_tokens_used} tokens`),{key:`completed`,label:`AI Enriched ✓`,tone:`success`,tooltip:t.length>0?t.join(` · `):`AI analysis complete`}}return e.last_enriched_at?{key:`detail_only`,label:`Details Only`,tone:`neutral`,tooltip:`Full job details fetched (0 LLM tokens)`}:{key:`none`,label:`Unenriched`,tone:`muted`,tooltip:`Not yet AI-enriched`}}function U(e){return H(e).key===`completed`}function Ke(e){if(!e)return[];let t=e.match(/\$\s*[\d,]+(?:\.\d+)?/g)??e.replace(/,/g,``).match(/\d+(?:\.\d+)?/g);return t?t.map(e=>Number.parseFloat(e.replace(/[$,\s]/g,``))).filter(e=>Number.isFinite(e)&&e>0):[]}function qe(e){let t=e.contract_type===`fixed`?[e.budget_amount,e.budget]:e.contract_type===`hourly`?[e.rate_max,e.rate_range,e.rate_min,e.budget]:[e.budget_amount,e.rate_max,e.budget,e.rate_range,e.rate_min];for(let e of t){let t=Ke(e);if(t.length>0)return Math.max(...t)}}function Je(e){return e.budget?.trim()?e.budget.trim():e.budget_amount?.trim()?e.budget_amount.trim():e.rate_range?.trim()?e.rate_range.trim():e.rate_min?.trim()||e.rate_max?.trim()?[e.rate_min,e.rate_max].filter(Boolean).join(` - `):`N/A`}function W(e,t){let n=new Set,r=[];if(Array.isArray(e.portfolio_references))for(let t of e.portfolio_references){let e=t;if(e.source!==`active_project`)continue;let i=e.display_name?.trim()||e.title?.trim()||``;i&&!n.has(i.toLowerCase())&&(n.add(i.toLowerCase()),r.push({label:i,isNda:e.visibility!==`public`}))}let i=e.score_breakdown?.matched_active_projects;if(Array.isArray(i))for(let e of i){if(typeof e!=`string`)continue;let i=e.trim();i&&!n.has(i.toLowerCase())&&(n.add(i.toLowerCase()),r.push({label:i,isNda:!!t?.has(i.toLowerCase())}))}return r}function Ye(e){let t=e.posted_at_est??e.created_at;if(!t)return 0;let n=Date.parse(t);return Number.isFinite(n)?n:0}function Xe(e){if(e.posted_text?.trim())return e.posted_text.trim();let t=e.posted_at_est??e.created_at;if(!t)return`--`;let n=new Date(t);return Number.isNaN(n.getTime())?`--`:c(n)}var G=[`discovered`,`ready`,`applied`,`archived`,`rejected`],Ze=class{tableWrap;paginationWrap;callbacks;jobs=[];anonymizedProjectLabels=new Set;lastSelectedRowId=null;state;table;constructor(e){this.tableWrap=e.tableWrap,this.paginationWrap=e.paginationWrap,this.callbacks=e.callbacks;let t=e.pageSize??50;this.state={columnVisibility:{},columnOrder:[],columnPinning:{left:[],right:[]},rowPinning:{top:[],bottom:[]},columnFilters:[],globalFilter:``,sorting:[],expanded:{},grouping:[],columnSizing:{},columnSizingInfo:{startOffset:null,startSize:null,deltaOffset:null,deltaPercentage:null,isResizingColumn:!1,columnSizingStart:[]},pagination:{pageIndex:0,pageSize:t},rowSelection:{}};let n=l(),r=[n.display({id:`select`,header:()=>``,enableSorting:!1}),n.accessor(e=>e.job_title??``,{id:`job_title`,header:`Job Title`}),n.accessor(e=>typeof e.score==`number`&&Number.isFinite(e.score)?e.score:-1,{id:`score`,header:`Score`}),n.accessor(e=>qe(e),{id:`budget`,header:`Budget / Rate`,sortUndefined:`last`}),n.accessor(e=>W(e,this.anonymizedProjectLabels).map(e=>e.label).join(`, `),{id:`matched_projects`,header:`Matched Projects`}),n.accessor(e=>e.client_spent_usd??-1,{id:`client_signals`,header:`Client Signals`}),n.accessor(e=>Ye(e),{id:`posted`,header:`Posted`}),n.accessor(e=>H(e).key,{id:`enrichment_state`,header:`Enrichment`}),n.display({id:`actions`,header:`Actions`,enableSorting:!1})];this.table=Le({data:this.jobs,columns:r,state:this.state,renderFallbackValue:null,enableRowSelection:!0,autoResetPageIndex:!1,getRowId:e=>String(e.id),getCoreRowModel:Re(),getSortedRowModel:Ge(),getFilteredRowModel:Ue(),getPaginationRowModel:We(),onStateChange:e=>{let t=this.state.rowSelection;this.state=typeof e==`function`?e(this.state):e,this.table.setOptions(e=>({...e,state:this.state})),this.render(),t!==this.state.rowSelection&&this.callbacks.onSelectionChange(this.getSelectedJobs())},globalFilterFn:(e,t,n)=>{let r=String(n??``).trim().toLowerCase();if(!r)return!0;let i=e.original;return[i.job_title,i.job_description,i.skills,i.source_query,i.client_country,W(i,this.anonymizedProjectLabels).map(e=>e.label).join(` `)].filter(Boolean).join(` `).toLowerCase().includes(r)}}),this.bindEvents(),this.render()}setAnonymizedProjectLabels(e){this.anonymizedProjectLabels=new Set(Array.from(e,e=>e.trim().toLowerCase())),this.render()}setJobs(e){this.jobs=e,this.table.setOptions(e=>({...e,data:this.jobs}));let t=new Set(e.map(e=>String(e.id))),n={},r=!1;for(let[e,i]of Object.entries(this.state.rowSelection))i&&t.has(e)?n[e]=!0:i&&(r=!0);this.lastSelectedRowId!==null&&!t.has(this.lastSelectedRowId)&&(this.lastSelectedRowId=null);let i=Math.max(0,this.table.getPageCount()-1),a=Math.min(this.state.pagination.pageIndex,i);(r||a!==this.state.pagination.pageIndex)&&(this.state={...this.state,...r?{rowSelection:n}:{},...a===this.state.pagination.pageIndex?{}:{pagination:{...this.state.pagination,pageIndex:a}}},this.table.setOptions(e=>({...e,state:this.state}))),this.render(),r&&this.callbacks.onSelectionChange(this.getSelectedJobs())}setGlobalFilter(e){this.state.globalFilter!==e&&this.table.setState(t=>({...t,globalFilter:e,pagination:{...t.pagination,pageIndex:0}}))}setColumnFilters(e){JSON.stringify(this.state.columnFilters)!==JSON.stringify(e)&&this.table.setState(t=>({...t,columnFilters:e,pagination:{...t.pagination,pageIndex:0}}))}setSorting(e){this.table.setState(t=>({...t,sorting:e}))}setPagination(e){this.table.setState(t=>({...t,pagination:e}))}getSelectedJobs(){let e=this.state.rowSelection;return this.jobs.filter(t=>!!e[String(t.id)])}getSelectedJobIds(){return this.getSelectedJobs().map(e=>e.id)}selectAllMatching(){let e=this.table.getFilteredRowModel().rows,t={...this.state.rowSelection};for(let n of e)t[n.id]=!0;this.table.setRowSelection(t)}clearSelection(){this.lastSelectedRowId=null,this.table.setRowSelection({})}getVisibleRows(){return this.table.getRowModel().rows}getFilteredRowCount(){return this.table.getFilteredRowModel().rows.length}bindEvents(){this.tableWrap.addEventListener(`click`,e=>{let t=e.target;if(!t)return;let n=t.closest(`[data-testid="select-all-page-checkbox"]`);if(n){let e=n.checked;this.table.toggleAllPageRowsSelected(e);return}let r=t.closest(`.dash-row-checkbox`);if(r){let t=r.dataset.jobId;if(!t)return;let n=r.checked,i=this.table.getPrePaginationRowModel().rows,a=i.findIndex(e=>e.id===t),o=this.lastSelectedRowId===null?-1:i.findIndex(e=>e.id===this.lastSelectedRowId);if(e.shiftKey&&o!==-1&&a!==-1){let e=Math.min(o,a),r=Math.max(o,a),s={...this.state.rowSelection};for(let t=e;t<=r;t++){let e=i[t];e&&(n?s[e.id]=!0:delete s[e.id])}this.lastSelectedRowId=t,this.table.setRowSelection(s);return}this.lastSelectedRowId=t;let s={...this.state.rowSelection};n?s[t]=!0:delete s[t],this.table.setRowSelection(s);return}let i=t.closest(`th[data-sortable="true"]`);if(i){let e=i.dataset.colId;e&&this.table.getColumn(e)?.toggleSorting();return}let a=t.closest(`.dash-job-title-btn, .js-row-inspect`);if(a){let e=Number.parseInt(a.dataset.jobId??``,10),t=this.jobs.find(t=>t.id===e);t&&this.callbacks.onInspectJob(t);return}let o=t.closest(`.js-row-enrich`);if(o){let e=Number.parseInt(o.dataset.jobId??``,10),t=this.jobs.find(t=>t.id===e);t&&this.callbacks.onEnrichSingleJob(t)}}),this.tableWrap.addEventListener(`change`,e=>{let t=e.target?.closest(`.js-row-status`);if(!t)return;let n=Number.parseInt(t.dataset.jobId??``,10);Number.isFinite(n)&&t.value&&this.callbacks.onStatusChange(n,t.value)}),this.paginationWrap.addEventListener(`click`,e=>{let t=e.target?.closest(`button[data-action]`);if(!t)return;let n=t.dataset.action;n===`prev-page`&&this.table.getCanPreviousPage()?this.table.previousPage():n===`next-page`&&this.table.getCanNextPage()?this.table.nextPage():n===`select-all-matching`?this.selectAllMatching():n===`clear-selection`&&this.clearSelection()}),this.paginationWrap.addEventListener(`change`,e=>{let t=e.target;if(t?.dataset.action===`page-size`){let e=Number.parseInt(t.value,10);Number.isFinite(e)&&e>0&&this.table.setPageSize(e)}})}render(){let e=this.table.getHeaderGroups(),r=this.table.getRowModel().rows,i=this.table.getFilteredRowModel().rows.length,a=this.state.pagination.pageIndex,o=this.state.pagination.pageSize,s=Math.max(1,this.table.getPageCount()),c=r.length>0&&this.table.getIsAllPageRowsSelected(),l=this.table.getIsSomePageRowsSelected(),u=e.map(e=>`<tr>${e.headers.map(e=>{let n=e.column.id;if(n===`select`)return`<th class="dash-th-select" scope="col"><input type="checkbox" id="dash-select-all-page" data-testid="select-all-page-checkbox" aria-label="Select all rows on page" ${c?`checked`:``} /></th>`;let r=e.column.getCanSort(),i=e.column.getIsSorted(),a=i===`asc`?` ▲`:i===`desc`?` ▼`:``,o=typeof e.column.columnDef.header==`string`?e.column.columnDef.header:n,s=n===`budget`?` data-testid="budget-header"`:``;return`<th scope="col" class="${r?`dash-th-sortable`:``}" data-col-id="${t(n)}" data-sortable="${r?`true`:`false`}"${s}>${t(o)}${a}</th>`}).join(``)}</tr>`).join(``),d=r.length===0?`<tr><td colspan="9" class="dash-empty-cell">No jobs match the current filters.</td></tr>`:r.map((e,r)=>{let i=e.original,a=t(String(i.id)),o=e.getIsSelected(),s=n(i.canonical_url??i.url??``),c=typeof i.score==`number`&&Number.isFinite(i.score)?String(Math.round(i.score)):`--`,l=(i.fit_label??``).toLowerCase(),u=l===`hot`||l===`ready`||l===`review`||l===`skip`?`dash-fit-${l}`:`dash-fit-unknown`,d=i.contract_type===`hourly`?`Hourly`:i.contract_type===`fixed`?`Fixed`:`Budget`,f=Je(i),p=W(i,this.anonymizedProjectLabels),m=p.length===0?`<span class="dash-muted">—</span>`:p.map(e=>`<span class="dash-proj-badge ${e.isNda?`dash-proj-nda`:``}">${t(e.label)}${e.isNda?` <strong>[NDA]</strong>`:``}</span>`).join(` `),h=[];i.payment_verified===!0?h.push(`<span class="dash-sig-verified">✓ Verified</span>`):i.payment_verified===!1&&h.push(`<span class="dash-sig-unverified">Unverified</span>`),i.client_spent&&h.push(`<span>${t(i.client_spent)}</span>`),typeof i.client_hire_rate==`number`&&Number.isFinite(i.client_hire_rate)&&h.push(`<span>${t(String(Math.round(i.client_hire_rate)))}% hire</span>`),i.proposals_tier&&h.push(`<span>${t(i.proposals_tier)}</span>`),typeof i.connects_required==`number`&&Number.isFinite(i.connects_required)&&h.push(`<span>${t(String(i.connects_required))} Connects</span>`),i.client_country&&h.push(`<span>${t(i.client_country)}</span>`);let g=H(i),_=i.status??`discovered`,ee=G.includes(_)?G:[_,...G];return`<tr class="${o?`dash-row-selected`:``}" data-job-id="${a}">
                <td class="dash-td-select">
                  <input type="checkbox" class="dash-row-checkbox" data-testid="row-checkbox-${a}" data-job-id="${a}" data-row-index="${r}" aria-label="Select ${t(i.job_title||`job`)}" ${o?`checked`:``} />
                </td>
                <td class="dash-td-title">
                  <div class="dash-title-row">
                    <button type="button" class="dash-job-title-btn" data-testid="row-title-btn-${a}" data-job-id="${a}">${t(i.job_title||`Untitled Job`)}</button>
                    ${s?`<a class="dash-ext-link" href="${t(s)}" target="_blank" rel="noopener noreferrer" title="Open on Upwork">↗</a>`:``}
                  </div>
                  <div class="dash-subtitle">
                    ${i.source_query?`<span>q: ${t(i.source_query)}</span>`:``}
                    ${i.source_feed?`<span>${t(i.source_feed)}</span>`:``}
                    ${i.experience_level?`<span>${t(i.experience_level)}</span>`:``}
                  </div>
                </td>
                <td class="dash-td-score">
                  <span class="dash-score-pill ${u}">${t(c)}${l?` ${t(l)}`:``}</span>
                </td>
                <td class="dash-td-budget">
                  <div class="dash-budget-type">${t(d)}</div>
                  <div class="dash-budget-val">${t(f)}</div>
                </td>
                <td class="dash-td-projects">${m}</td>
                <td class="dash-td-signals"><div class="dash-signals-wrap">${h.join(` · `)||`<span class="dash-muted">—</span>`}</div></td>
                <td class="dash-td-posted">${t(Xe(i))}</td>
                <td class="dash-td-enrich">
                  <span class="dash-enrich-badge dash-enrich-${g.tone}" data-testid="enrichment-badge-${a}" title="${t(g.tooltip)}">${t(g.label)}</span>
                </td>
                <td class="dash-td-actions">
                  <div class="dash-row-actions">
                    <button type="button" class="dash-btn-sm js-row-inspect" data-testid="row-inspect-btn-${a}" data-job-id="${a}">Inspect</button>
                    <button type="button" class="dash-btn-sm dash-btn-accent js-row-enrich" data-testid="row-enrich-btn-${a}" data-job-id="${a}">Enrich</button>
                    <select class="dash-status-select js-row-status" data-testid="row-status-select-${a}" data-job-id="${a}" aria-label="Status for ${t(i.job_title||`job`)}">
                      ${ee.map(e=>`<option value="${t(e)}" ${e===_?`selected`:``}>${t(e)}</option>`).join(``)}
                    </select>
                  </div>
                </td>
              </tr>`}).join(``);this.tableWrap.innerHTML=`
      <div class="dash-table-scroller">
        <table class="dash-table" data-testid="jobs-table">
          <thead>${u}</thead>
          <tbody>${d}</tbody>
        </table>
      </div>
    `;let f=this.tableWrap.querySelector(`#dash-select-all-page`);f&&(f.indeterminate=l&&!c);let p=this.getSelectedJobIds().length;this.paginationWrap.innerHTML=`
      <div class="dash-pagination-bar">
        <div class="dash-pagination-left">
          <span class="dash-muted">${i} matching job${i===1?``:`s`}</span>
          ${i>0?`<button type="button" class="dash-btn-sm" data-action="select-all-matching" data-testid="select-all-matching-btn">Select all matching (${i})</button>`:``}
          ${p>0?`<button type="button" class="dash-btn-sm" data-action="clear-selection" data-testid="clear-selection-btn">Clear selection (${p})</button>`:``}
        </div>
        <div class="dash-pagination-right">
          <label class="dash-page-size-label">
            Rows:
            <select data-action="page-size" data-testid="page-size-select">
              ${[25,50,100].map(e=>`<option value="${e}" ${o===e?`selected`:``}>${e}</option>`).join(``)}
            </select>
          </label>
          <button type="button" class="dash-btn-sm" data-action="prev-page" ${this.table.getCanPreviousPage()?``:`disabled`}>Prev</button>
          <span class="dash-page-info">Page ${a+1} of ${s}</span>
          <button type="button" class="dash-btn-sm" data-action="next-page" ${this.table.getCanNextPage()?``:`disabled`}>Next</button>
        </div>
      </div>
    `}};function K(e){return JSON.stringify([e.id,e.updated_at??``,e.job_title??``,e.job_description??``,e.status??``,e.score??``,e.fit_label??``,e.score_reasoning??``,e.score_breakdown??null,e.last_enriched_at??``,e.ai_enrichment_status??``,e.ai_enriched_at??``,e.ai_enrichment_error??``,e.ai_model??``,e.ai_effort??``,e.ai_tokens_used??``,e.proposal??``,e.execution_prompt??``,e.time_estimate??``,e.tone_analysis??``,e.workload_division??null,e.questions_for_client??null,e.tips_and_advice??null,e.portfolio_references??[],e.skills??``,e.attachments??[],e.screening_questions??[],e.qualifications??[],e.client_activity??null])}function Qe(e){return Array.isArray(e)?e.map(e=>String(e).trim()).filter(Boolean):typeof e==`string`?e.split(`,`).map(e=>e.trim()).filter(Boolean):[]}function q(e){return typeof e==`number`?Number.isFinite(e)?e:0:typeof e==`string`?e:0}function $e(e){return!e||e.length===0?`<p class="dash-muted">No portfolio or active-project references attached yet.</p>`:`<div class="dash-refs-list">${e.map(e=>{let r=e,i=r.visibility===`public`,a=i?`[PUBLIC]`:`[ANONYMIZED/NDA]`,o=i?`dash-vis-public`:`dash-vis-nda`,s=r.display_name?.trim()||r.title?.trim()||`Untitled Reference`,c=r.link??r.url,l=c?n(c):null,u=r.source??``,d=Array.isArray(r.tech_stack)?r.tech_stack.map(e=>`<span class="dash-skill-chip">${t(e)}</span>`).join(``):``;return`<div class="dash-ref-card">
        <div class="dash-ref-header">
          <span class="dash-vis-badge ${o}">${a}</span>
          <strong>${t(s)}</strong>
          ${u?`<span class="dash-muted">${t(u)}</span>`:``}
          ${r.activity_tier?`<span class="dash-muted">· ${t(r.activity_tier)}</span>`:``}
        </div>
        ${r.summary?`<p class="dash-ref-summary">${t(r.summary)}</p>`:``}
        ${d?`<div class="dash-skills-wrap">${d}</div>`:``}
        ${l?`<a class="dash-ext-link" href="${t(l)}" target="_blank" rel="noopener noreferrer">View reference ↗</a>`:``}
      </div>`}).join(``)}</div>`}var et=class{container;callbacks;currentJob=null;currentSignature=``;activeTab=`overview`;isOpen=!1;destroyed=!1;openGeneration=0;isEnriching=!1;isSavingDraft=!1;actionMessage=``;actionTone=`neutral`;onKeyDown;onClick;constructor(e){this.container=e.container,this.callbacks=e.callbacks,this.onKeyDown=e=>{!this.destroyed&&e.key===`Escape`&&this.isOpen&&this.close()},this.onClick=e=>{if(this.destroyed)return;let t=e.target;t&&(t.closest(`[data-testid="drawer-close-btn"]`)||t.classList.contains(`dash-drawer-backdrop`)?this.close():t.closest(`[data-testid="drawer-tab-overview"]`)?(this.activeTab=`overview`,this.render()):t.closest(`[data-testid="drawer-tab-ai"]`)?(this.activeTab=`ai`,this.render()):t.closest(`[data-testid="drawer-enrich-btn"]`)?this.handleEnrichClick():t.closest(`[data-testid="save-proposal-draft-btn"]`)?this.handleSaveDraftClick():t.closest(`[data-testid="copy-execution-prompt-btn"]`)&&this.handleCopyPromptClick())},document.addEventListener(`keydown`,this.onKeyDown),this.bindEvents(),this.render()}destroy(){this.destroyed=!0,this.isOpen=!1,this.openGeneration+=1,document.removeEventListener(`keydown`,this.onKeyDown),this.container.removeEventListener(`click`,this.onClick)}getIsOpen(){return this.isOpen}getActiveTab(){return this.activeTab}getCurrentJobId(){return this.currentJob?.id??null}open(e){this.destroyed||(this.openGeneration+=1,this.currentJob=e,this.currentSignature=K(e),this.activeTab=`overview`,this.isOpen=!0,this.isEnriching=!1,this.isSavingDraft=!1,this.actionMessage=``,this.actionTone=`neutral`,this.render())}updateJobIfOpen(e){if(this.destroyed||!this.isOpen||!this.currentJob||this.currentJob.id!==e.id)return;let t=K(e);if(t===this.currentSignature)return;this.currentJob=e,this.currentSignature=t;let n=this.container.querySelector(`.dash-drawer-body`)?.scrollTop??0;this.render();let r=this.container.querySelector(`.dash-drawer-body`);r&&(r.scrollTop=n)}close(){!this.destroyed&&this.isOpen&&(this.openGeneration+=1,this.isOpen=!1,this.currentJob=null,this.currentSignature=``,this.isEnriching=!1,this.isSavingDraft=!1,this.actionMessage=``,this.actionTone=`neutral`,this.render(),this.callbacks.onClose?.())}bindEvents(){this.destroyed||this.container.addEventListener(`click`,this.onClick)}async handleEnrichClick(){if(this.destroyed||!this.currentJob||this.isEnriching)return;let e=this.currentJob,t=this.openGeneration,n=e.id;this.isEnriching=!0,this.actionMessage=`Running AI analysis...`,this.actionTone=`neutral`,this.render();try{let r=await this.callbacks.onEnrichJob(e);if(this.destroyed||!this.isOpen||this.openGeneration!==t||this.currentJob?.id!==n)return;r&&(this.currentJob=r,this.currentSignature=K(r)),r?.ai_enrichment_status===`failed`||r?.ai_enrichment_error?(this.actionMessage=r?.ai_enrichment_error||`Enrichment failed`,this.actionTone=`error`):(this.actionMessage=`AI analysis complete.`,this.actionTone=`success`)}catch(e){if(this.destroyed||!this.isOpen||this.openGeneration!==t||this.currentJob?.id!==n)return;this.actionMessage=e instanceof Error?e.message:`Enrichment failed`,this.actionTone=`error`}finally{!this.destroyed&&this.isOpen&&this.openGeneration===t&&this.currentJob?.id===n&&(this.isEnriching=!1,this.render())}}async handleSaveDraftClick(){if(this.destroyed||!this.currentJob||this.isSavingDraft)return;let e=this.currentJob,t=this.openGeneration,n=e.id;this.isSavingDraft=!0,this.actionMessage=`Saving proposal draft...`,this.actionTone=`neutral`,this.render();try{if(await this.callbacks.onSaveProposalDraft(e),this.destroyed||!this.isOpen||this.openGeneration!==t||this.currentJob?.id!==n)return;this.actionMessage=`Saved as proposal draft.`,this.actionTone=`success`}catch(e){if(this.destroyed||!this.isOpen||this.openGeneration!==t||this.currentJob?.id!==n)return;this.actionMessage=e instanceof Error?e.message:`Failed to save draft`,this.actionTone=`error`}finally{!this.destroyed&&this.isOpen&&this.openGeneration===t&&this.currentJob?.id===n&&(this.isSavingDraft=!1,this.render())}}async handleCopyPromptClick(){if(this.destroyed)return;let e=this.currentJob,t=e?.execution_prompt??``;if(!e||!t)return;let n=this.openGeneration,r=e.id;try{if(await navigator.clipboard?.writeText(t),this.destroyed||!this.isOpen||this.openGeneration!==n||this.currentJob?.id!==r)return;this.actionMessage=`Execution prompt copied to clipboard.`,this.actionTone=`success`}catch{if(this.destroyed||!this.isOpen||this.openGeneration!==n||this.currentJob?.id!==r)return;this.actionMessage=`Clipboard unavailable in this context.`,this.actionTone=`error`}!this.destroyed&&this.isOpen&&this.openGeneration===n&&this.currentJob?.id===r&&this.render()}renderOverviewTab(e){let r=Qe(e.skills),i=Array.isArray(e.screening_questions)?e.screening_questions:[],a=Array.isArray(e.qualifications)?e.qualifications:[],o=Array.isArray(e.attachments)?e.attachments:[],s=e.score_breakdown??{},c=Array.isArray(s.matched_active_projects)?s.matched_active_projects:[];return`
      <section class="dash-drawer-section">
        <h3>Client &amp; Job Signals</h3>
        <div class="dash-kv-grid">
          <div><span class="dash-kv-label">Contract</span><strong>${t(e.contract_type||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Budget / Rate</span><strong>${t(e.budget||e.rate_range||e.budget_amount||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Experience</span><strong>${t(e.experience_level||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Duration</span><strong>${t(e.duration||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Hours / Week</span><strong>${t(e.hours_per_week||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Payment</span><strong>${e.payment_verified===!0?`Verified`:e.payment_verified===!1?`Unverified`:`Unknown`}</strong></div>
          <div><span class="dash-kv-label">Client Spent</span><strong>${t(e.client_spent||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Client Rating</span><strong>${typeof e.client_rating==`number`&&Number.isFinite(e.client_rating)?`${t(String(e.client_rating))} (${t(String(q(e.client_reviews)))} reviews)`:`N/A`}</strong></div>
          <div><span class="dash-kv-label">Client Hires / Rate</span><strong>${typeof e.client_hires==`number`&&Number.isFinite(e.client_hires)?t(String(e.client_hires)):`--`} / ${typeof e.client_hire_rate==`number`&&Number.isFinite(e.client_hire_rate)?`${t(String(Math.round(e.client_hire_rate)))}%`:`--`}</strong></div>
          <div><span class="dash-kv-label">Country</span><strong>${t(e.client_country||`N/A`)}</strong></div>
          <div><span class="dash-kv-label">Proposals</span><strong>${t(e.proposals_tier||(typeof e.proposals_count==`number`&&Number.isFinite(e.proposals_count)?String(e.proposals_count):`N/A`))}</strong></div>
          <div><span class="dash-kv-label">Connects</span><strong>${typeof e.connects_required==`number`&&Number.isFinite(e.connects_required)?t(String(e.connects_required)):`N/A`}</strong></div>
        </div>
        ${e.client_activity?`<p class="dash-muted dash-activity-line">Activity: interviewing ${t(String(q(e.client_activity.interviewing)))} · invites ${t(String(q(e.client_activity.invites_sent)))} · unanswered ${t(String(q(e.client_activity.unanswered_invites)))}${e.client_activity.last_viewed?` · last viewed ${t(e.client_activity.last_viewed)}`:``}</p>`:``}
      </section>

      <section class="dash-drawer-section">
        <h3>Job Description</h3>
        <div class="dash-description-box">${t(e.job_description||`No description stored.`).replace(/\n/g,`<br>`)}</div>
      </section>

      ${r.length>0?`<section class="dash-drawer-section">
              <h3>Skills</h3>
              <div class="dash-skills-wrap">${r.map(e=>`<span class="dash-skill-chip">${t(e)}</span>`).join(``)}</div>
            </section>`:``}

      ${c.length>0||e.score_reasoning?`<section class="dash-drawer-section">
              <h3>Score &amp; Active Project Overlap</h3>
              ${e.score_reasoning?`<p>${t(e.score_reasoning)}</p>`:``}
              ${c.length>0?`<div class="dash-skills-wrap">${c.map(e=>`<span class="dash-proj-badge">${t(String(e))}</span>`).join(``)}</div>`:``}
            </section>`:``}

      ${i.length>0?`<section class="dash-drawer-section">
              <h3>Screening Questions</h3>
              <ol class="dash-list">${i.map(e=>`<li>${t(e.prompt)}${e.required?` <span class="dash-req-tag">(Required)</span>`:``}</li>`).join(``)}</ol>
            </section>`:``}

      ${a.length>0?`<section class="dash-drawer-section">
              <h3>Qualifications</h3>
              <ul class="dash-list">${a.map(e=>`<li>${e.met===!0?`✓ `:e.met===!1?`✗ `:`• `}<strong>${t(e.name)}:</strong> ${t(e.value)}</li>`).join(``)}</ul>
            </section>`:``}

      ${o.length>0?`<section class="dash-drawer-section">
              <h3>Attachments</h3>
              <ul class="dash-list">${o.map(e=>{if(!e||typeof e!=`object`)return``;let r=e.url?n(e.url):null,i=e.filename||e.title||r||`Attachment`;return r?`<li><a href="${t(r)}" target="_blank" rel="noopener noreferrer">${t(i)}</a></li>`:`<li>${t(i)} <span class="dash-muted">(unsafe link blocked)</span></li>`}).join(``)}</ul>
            </section>`:``}
    `}renderAiTab(e){let n=H(e),r=!!e.proposal?.trim(),i={};e.proposal&&(i.proposal=e.proposal),e.execution_prompt&&(i.execution_prompt=e.execution_prompt),e.time_estimate&&(i.time_estimate=e.time_estimate),e.workload_division&&(i.workload_division=e.workload_division),e.questions_for_client&&(i.questions_for_client=e.questions_for_client),e.tips_and_advice&&(i.tips_and_advice=e.tips_and_advice),e.tone_analysis&&(i.tone_analysis=e.tone_analysis);let a=Object.keys(i).length>0;return`
      <div class="dash-drawer-ai-actions">
        <button type="button" class="dash-btn-primary" data-testid="drawer-enrich-btn" ${this.isEnriching?`disabled`:``}>
          ${this.isEnriching?`Analyzing...`:`Enrich / Re-Analyze`}
        </button>
        <button type="button" class="dash-btn-secondary" data-testid="save-proposal-draft-btn" ${!r||this.isSavingDraft?`disabled`:``}>
          ${this.isSavingDraft?`Saving...`:`Save as Proposal Draft`}
        </button>
      </div>

      ${this.actionMessage?`<div class="dash-banner dash-banner-${this.actionTone}" data-testid="drawer-action-feedback">${t(this.actionMessage)}</div>`:``}

      <div class="dash-ai-meta-strip">
        <span><strong>Status:</strong> ${t(n.label)}</span>
        ${e.ai_model?`<span><strong>Model:</strong> ${t(e.ai_model)}</span>`:``}
        ${e.ai_effort?`<span><strong>Effort:</strong> ${t(e.ai_effort)}</span>`:``}
        ${typeof e.ai_tokens_used==`number`&&Number.isFinite(e.ai_tokens_used)?`<span><strong>Tokens:</strong> ${t(String(e.ai_tokens_used))}</span>`:``}
        ${e.ai_enriched_at?`<span><strong>Enriched:</strong> ${t(e.ai_enriched_at)}</span>`:``}
      </div>

      ${e.ai_enrichment_error?`<div class="dash-banner dash-banner-error">${t(e.ai_enrichment_error)}</div>`:``}

      <section class="dash-drawer-section">
        <h3>Portfolio &amp; Active Project References</h3>
        ${$e(e.portfolio_references)}
      </section>

      ${e.execution_prompt?`<section class="dash-drawer-section">
              <div class="dash-section-head-row">
                <h3>Execution Prompt</h3>
                <button type="button" class="dash-btn-sm" data-testid="copy-execution-prompt-btn">Copy Execution Prompt</button>
              </div>
              <pre class="dash-code-box">${t(e.execution_prompt)}</pre>
            </section>`:``}

      <section class="dash-drawer-section">
        <h3>AI Analysis</h3>
        ${a?`<div class="dash-analysis-wrap">${s(i,!1)}</div>`:`<p class="dash-muted">No AI analysis generated yet. Click "Enrich / Re-Analyze" to analyze this job.</p>`}
      </section>
    `}render(){if(this.destroyed)return;if(!this.isOpen||!this.currentJob){this.container.innerHTML=``,this.container.hidden=!0;return}let e=this.currentJob,i=n(e.canonical_url??e.url??``),a=typeof e.score==`number`&&Number.isFinite(e.score)?`${Math.round(e.score)}`:`--`;this.container.hidden=!1,this.container.innerHTML=`
      <div class="dash-drawer-backdrop"></div>
      <aside class="dash-drawer-panel" role="dialog" aria-modal="true" aria-label="Job Inspector" data-testid="job-inspector-drawer">
        <header class="dash-drawer-header">
          <div class="dash-drawer-title-wrap">
            <h2>${t(e.job_title||`Untitled Job`)}</h2>
            <div class="dash-drawer-badges">
              <span class="dash-score-pill">${t(a)} ${t(e.fit_label??``)}</span>
              ${i?`<a class="dash-ext-link" href="${t(i)}" target="_blank" rel="noopener noreferrer">Open on Upwork ↗</a>`:``}
            </div>
          </div>
          <button type="button" class="dash-btn-sm" data-testid="drawer-close-btn" aria-label="Close drawer">Close</button>
        </header>

        <div class="dash-drawer-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="${this.activeTab===`overview`?`true`:`false`}" class="dash-drawer-tab ${this.activeTab===`overview`?`active`:``}" data-testid="drawer-tab-overview">
            Overview &amp; Client Signals
          </button>
          <button type="button" role="tab" aria-selected="${this.activeTab===`ai`?`true`:`false`}" class="dash-drawer-tab ${this.activeTab===`ai`?`active`:``}" data-testid="drawer-tab-ai">
            AI Analysis
          </button>
        </div>

        <div class="dash-drawer-body">
          ${this.activeTab===`overview`?this.renderOverviewTab(e):this.renderAiTab(e)}
        </div>
      </aside>
    `,this.activeTab===`ai`&&r(this.container)}};globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome;var tt={development:{apiBaseUrl:`http://127.0.0.1:9090`,profileApiEndpoint:`http://127.0.0.1:9090/api/profile`,jobsApiEndpoint:`http://127.0.0.1:9090/api/jobs`},staging:{apiBaseUrl:`https://staging-api.upworkbuddy.app`,profileApiEndpoint:`https://staging-api.upworkbuddy.app/api/profile`,jobsApiEndpoint:`https://staging-api.upworkbuddy.app/api/jobs`},production:{apiBaseUrl:`https://api.upworkbuddy.app`,profileApiEndpoint:`https://api.upworkbuddy.app/api/profile`,jobsApiEndpoint:`https://api.upworkbuddy.app/api/jobs`}},nt={profileStorageKey:`upworkBuddyProfileData`,defaultProfile:`Experienced full-stack developer with 10+ years in web development, specializing in Go, React, and PostgreSQL. Strong background in building scalable APIs and database-driven applications.`,defaultSkills:`Go, JavaScript, TypeScript, React, Node.js, PostgreSQL, MySQL, Docker, Git, RESTful APIs, GraphQL, AWS, CI/CD`,env:`development`};function rt(e){let t=e.toLowerCase().trim();return t===`local`||t===`development`?`development`:t===`staging`||t===`preprod`?`staging`:t===`production`||t===`prod`?`production`:t in tt?t:null}function it(){try{if(typeof localStorage<`u`&&localStorage.getItem){let e=localStorage.getItem(`upwork_buddy_env`);if(e){let t=rt(e);if(t)return t}}}catch{}let e=globalThis;try{let t=e.chrome?.runtime?.getManifest?.();if(t&&typeof t.upwork_buddy_env==`string`){let e=rt(t.upwork_buddy_env);if(e)return e}}catch{}try{let t=e.location?.hostname??``;if(t===`localhost`||t===`127.0.0.1`||t.endsWith(`.local`)||t===`www.upwork.com`||t.endsWith(`.upwork.com`))return`development`;if(t.includes(`staging`)||t.includes(`preprod`)||t.endsWith(`.staging`))return`staging`;if(e.chrome?.runtime?.id)return`development`;if(t!==``)return`production`}catch{}return`development`}function at(e,t){let n=e??it(),r=tt[n]??tt.development;return{apiBaseUrl:t?.apiBaseUrl??r.apiBaseUrl,profileApiEndpoint:t?.profileApiEndpoint??r.profileApiEndpoint,jobsApiEndpoint:t?.jobsApiEndpoint??r.jobsApiEndpoint,...nt,env:n}}at();var ot=class extends Error{status;constructor(e,t){super(t),this.name=`WatchersApiError`,this.status=e}};async function J(e,t,n){let r=await e(t,n);if(r.status===204)return;let i=await r.text(),a={};if(i)try{a=JSON.parse(i)}catch{a={}}if(!r.ok){let e=a;throw new ot(r.status,e.error||e.message||`Request failed (${r.status})`)}return a}function st(e,t=``){let n=t.replace(/\/+$/,``),r={"Content-Type":`application/json`};return{listWatchers(){return J(e,`${n}/api/watchers`,{method:`GET`})},createWatcher(t){return J(e,`${n}/api/watchers`,{method:`POST`,headers:r,body:JSON.stringify(t)})},getWatchersStatus(){return J(e,`${n}/api/watchers/status`,{method:`GET`})},getWatcher(t){return J(e,`${n}/api/watchers/${t}`,{method:`GET`})},updateWatcher(t,i){return J(e,`${n}/api/watchers/${t}`,{method:`PATCH`,headers:r,body:JSON.stringify(i)})},deleteWatcher(t){return J(e,`${n}/api/watchers/${t}`,{method:`DELETE`})},toggleWatcher(t,i){return J(e,`${n}/api/watchers/${t}/toggle`,{method:`POST`,headers:r,body:JSON.stringify(i===void 0?{}:{enabled:i})})},resumeWatcher(t){return J(e,`${n}/api/watchers/${t}/resume`,{method:`POST`,headers:r,body:`{}`})},runWatcher(t,i){return J(e,`${n}/api/watchers/${t}/run`,{method:`POST`,headers:r,body:JSON.stringify(i??{})})},listWatcherRuns(t,r){let i=new URLSearchParams;return i.set(`limit`,String(r?.limit??20)),i.set(`offset`,String(r?.offset??0)),J(e,`${n}/api/watchers/${t}/runs?${i}`,{method:`GET`})},listWatcherEvents(t,r){let i=new URLSearchParams;return i.set(`limit`,String(r?.limit??50)),i.set(`offset`,String(r?.offset??0)),J(e,`${n}/api/watchers/${t}/events?${i}`,{method:`GET`})},getNotificationConfig(){return J(e,`${n}/api/notifications/config`,{method:`GET`})},updateNotificationConfig(t){return J(e,`${n}/api/notifications/config`,{method:`PUT`,headers:r,body:JSON.stringify(t)})},testNotifications(t){return J(e,`${n}/api/notifications/test`,{method:`POST`,headers:r,body:JSON.stringify(t?{channel:t}:{})})},detectTelegramChat(t){return J(e,`${n}/api/notifications/telegram/detect-chat`,{method:`POST`,headers:r,body:JSON.stringify(t??{})})}}}var ct=[{id:`hot_job_alert`,label:`Hot Job Alert`},{id:`pending_approval`,label:`Pending Approval`},{id:`proposal_submitted`,label:`Proposal Submitted`},{id:`human_action_required`,label:`Human Action Required`},{id:`watcher_paused`,label:`Watcher Paused`}];function lt(e){return e.split(`,`).map(e=>e.trim()).filter(Boolean)}function Y(e){let t=e.trim();if(!t)return null;let n=Number.parseInt(t,10);return Number.isFinite(n)?n:null}function X(e){let t=e.trim();if(!t)return null;let n=Number.parseFloat(t);return Number.isFinite(n)?n:null}function ut(){return{name:``,description:``,enabled:!1,discovery_backend:`chrome`,discovery_config:{source:`search`,queries:[],max_pages:3,per_page:20,contract_type:``,payment_verified_only:!1,from_active_projects:!1,scraper_fs_profile:``,scraper_fs_adapter:`flaresolverr`,scraper_fs_proxy_mode:`rotation`},interval_minutes:5,jitter_ratio:.35,active_hours:``,min_score:75,max_proposals:null,max_posted_age_minutes:null,max_connects_per_job:null,require_payment_verified:!0,required_keywords:[],exclude_keywords:[],action_mode:`draft_and_fill`,llm_model:``,llm_effort:``,bid_strategy:{hourly_rate:null,fixed_multiplier:null,min_fixed_bid:null,max_fixed_bid:null,rate_increase:``,boost_connects:null},auto_submit_min_confidence:.85,fallback_on_screening_questions:!0,max_reactions_per_tick:2,seed_baseline_on_first_run:!0}}var dt=class{rootEl;api;options;destroyed=!1;status=null;rules=[];notifConfig=null;bannerMessage=``;bannerError=!1;testResult=null;formOpen=!1;editingRuleId=null;formBackend=`chrome`;inspectedRuleId=null;inspectedRuns=[];inspectedEvents=[];inspectorLoading=!1;runningRuleIds=new Set;detectingTelegramChat=!1;detectedTelegramChats=[];detectedTelegramHint=``;pendingTelegramToken=``;constructor(e,t,n={}){this.rootEl=e,this.api=st(t,``),this.options=n}async init(){this.destroyed||await this.refreshAll()}destroy(){this.destroyed=!0,this.rootEl.innerHTML=``}async refreshAll(){if(!this.destroyed){try{let[e,t,n]=await Promise.all([this.api.getWatchersStatus(),this.api.listWatchers(),this.api.getNotificationConfig()]);if(this.destroyed)return;this.status=e,this.rules=Array.isArray(t.rules)?t.rules:[],this.notifConfig=n.config??null,this.options.onStatusChange?.(e)}catch(e){if(this.handleAuthOrError(e,`Failed to load watchers`))return}this.destroyed||this.render()}}handleAuthOrError(e,t){return this.destroyed?!0:e instanceof ot&&e.status===401?(this.options.onUnauthorized?.(),!0):(this.bannerError=!0,this.bannerMessage=e instanceof Error?e.message:t,!1)}setBanner(e,t=!1){this.bannerMessage=e,this.bannerError=t}render(){if(this.destroyed)return;let e=this.status,n=!!e?.running,r=e?.active_rules??this.rules.filter(e=>e.enabled&&!e.paused_reason).length,i=e?.paused_rules??this.rules.filter(e=>!!e.paused_reason).length,a=e?.active_reactions??0,o=e?.scraper_fs_available??!1,s=e?.scraper_fs_reason??``,c=this.bannerMessage?`<div class="dash-banner ${this.bannerError?`dash-banner-error`:`dash-banner-success`}" data-testid="watchers-banner" role="status">${t(this.bannerMessage)}</div>`:``,l=this.editingRuleId===null?null:this.rules.find(e=>e.id===this.editingRuleId)??null;this.rootEl.innerHTML=`
      <div class="watchers-panel-inner">
        <div class="watchers-header">
          <div class="watchers-header-title">
            <strong>Automated Job Watchers</strong>
            <span class="dash-pill" data-testid="watchers-daemon-status" data-state="${n?`connected`:`disconnected`}">
              ${n?`Daemon Running`:`Daemon Stopped`}
            </span>
            <span class="dash-pill" data-testid="watchers-counts-pill">
              ${r} active · ${i} paused · ${a} reacting
            </span>
            <span class="dash-pill" data-testid="watchers-scraper-fs-status" data-state="${o?`connected`:`disconnected`}" title="${t(s)}">
              scraper_fs: ${o?`Available`:`Unavailable${s?` (${t(s)})`:``}`}
            </span>
          </div>
          <div class="watchers-header-actions">
            <button type="button" class="dash-btn-primary" data-testid="new-watcher-btn">+ New Watch Rule</button>
            <button type="button" class="dash-btn-secondary" data-testid="refresh-watchers-btn">Refresh</button>
          </div>
        </div>

        ${c}

        ${this.formOpen?this.renderRuleForm(l):``}

        <div class="watchers-rules-section">
          <h4 class="watchers-section-title">Watch Rules (${this.rules.length})</h4>
          <div class="watchers-rules-list" data-testid="watchers-rules-list">
            ${this.rules.length===0?`<p class="dash-muted">No watch rules configured yet. Create one to start automated discovery.</p>`:this.rules.map(e=>this.renderRuleCard(e)).join(``)}
          </div>
        </div>

        ${this.inspectedRuleId===null?``:this.renderInspector()}

        ${this.renderNotificationSettings()}
      </div>
    `,this.bindEvents()}renderRuleCard(e){let n=!!e.paused_reason,r=this.runningRuleIds.has(e.id),i=r?`Running...`:n?`Paused: ${e.paused_reason}`:e.enabled?`Active`:`Disabled`,a=r?`connected`:n?`disconnected`:e.enabled?`connected`:`idle`,o=e.discovery_backend===`scraper_fs`?`scraper_fs`:`Chrome`,s=Array.isArray(e.discovery_config?.queries)?e.discovery_config.queries.join(`, `):e.discovery_config?.query||``,c=!!e.discovery_config?.from_active_projects,l=s?c?`${s} (+ active project tech stacks)`:s:c?`Active project tech stacks`:``,u=e.discovery_config?.max_pages&&e.discovery_config.max_pages>0?e.discovery_config.max_pages:1,d=e.discovery_config?.per_page;return`
      <article class="watcher-card" data-testid="watcher-rule-card" data-rule-id="${e.id}">
        <div class="watcher-card-top">
          <div class="watcher-card-title-row">
            <strong>${t(e.name)}</strong>
            <span class="dash-pill" data-testid="watcher-rule-status" data-state="${a}">${t(i)}</span>
            <span class="watcher-badge watcher-badge-backend" data-testid="watcher-backend-badge" data-backend="${t(e.discovery_backend)}">${t(o)}</span>
            <span class="watcher-badge watcher-badge-action" data-testid="watcher-action-badge">${t(e.action_mode)}</span>
          </div>
          <div class="watcher-card-actions">
            <button type="button" class="dash-btn-sm js-watcher-toggle" data-testid="watcher-toggle-btn" data-id="${e.id}">
              ${e.enabled?`Disable`:`Enable`}
            </button>
            <button type="button" class="dash-btn-sm dash-btn-accent js-watcher-run" data-testid="watcher-run-btn" data-id="${e.id}" ${r?`disabled`:``}>
              ${r?`Running...`:`Run Now`}
            </button>
            <button type="button" class="dash-btn-sm js-watcher-dry-run" data-testid="watcher-dry-run-btn" data-id="${e.id}" ${r?`disabled`:``}>
              Dry Run
            </button>
            ${n?`<button type="button" class="dash-btn-sm dash-btn-primary js-watcher-resume" data-testid="watcher-resume-btn" data-id="${e.id}">Resume</button>`:``}
            <button type="button" class="dash-btn-sm js-watcher-inspect" data-testid="watcher-inspect-btn" data-id="${e.id}">
              Runs &amp; Events
            </button>
            <button type="button" class="dash-btn-sm js-watcher-edit" data-testid="watcher-edit-btn" data-id="${e.id}">
              Edit
            </button>
            <button type="button" class="dash-btn-sm dash-btn-danger js-watcher-delete" data-testid="watcher-delete-btn" data-id="${e.id}" ${r?`disabled`:``}>
              Delete
            </button>
          </div>
        </div>
        ${e.description?`<p class="watcher-card-desc">${t(e.description)}</p>`:``}
        <div class="watcher-card-meta">
          <span>Every ${e.interval_minutes}m (min score ${e.min_score})</span>
          ${l?`<span>Queries: ${t(l)}</span>`:``}
          <span>Pages: ${u}${d?` (${d}/page)`:``}</span>
          <span>Next: ${t(e.next_run_at||`—`)}</span>
          <span>Last: ${t(e.last_run_at||`Never`)}</span>
          ${e.last_error?`<span class="watcher-error-text">Last error: ${t(e.last_error)}</span>`:``}
        </div>
      </article>
    `}renderRuleForm(e){let n=e?{name:e.name,description:e.description,enabled:e.enabled,discovery_backend:e.discovery_backend,discovery_config:e.discovery_config??{},interval_minutes:e.interval_minutes,jitter_ratio:e.jitter_ratio,active_hours:e.active_hours,min_score:e.min_score,max_proposals:e.max_proposals??null,max_posted_age_minutes:e.max_posted_age_minutes??null,max_connects_per_job:e.max_connects_per_job??null,require_payment_verified:e.require_payment_verified,required_keywords:e.required_keywords??[],exclude_keywords:e.exclude_keywords??[],action_mode:e.action_mode,llm_model:e.llm_model,llm_effort:e.llm_effort,bid_strategy:e.bid_strategy??{},auto_submit_min_confidence:e.auto_submit_min_confidence,fallback_on_screening_questions:e.fallback_on_screening_questions,max_reactions_per_tick:e.max_reactions_per_tick,seed_baseline_on_first_run:e.seed_baseline_on_first_run}:ut(),r=this.formBackend,i=n.discovery_config??{},a=n.bid_strategy??{},o=Array.isArray(i.queries)?i.queries.join(`, `):i.query??``,s=r===`scraper_fs`&&this.status?.scraper_fs_available===!1;return`
      <form id="watcher-rule-form" class="watcher-form" data-testid="watcher-rule-form">
        <div class="watcher-form-header">
          <strong>${e?`Edit Watch Rule: ${t(e.name)}`:`Create Watch Rule`}</strong>
        </div>

        <div class="watcher-form-grid">
          <label>
            Rule Name *
            <input type="text" id="wf-name" data-testid="watcher-form-name" required value="${t(n.name)}" placeholder="e.g. Go + Postgres Hourly" />
          </label>
          <label class="dash-field-wide">
            Description
            <input type="text" id="wf-description" data-testid="watcher-form-description" value="${t(n.description??``)}" placeholder="Optional notes" />
          </label>
          <label class="dash-checkbox-inline">
            <input type="checkbox" id="wf-enabled" data-testid="watcher-form-enabled" ${n.enabled===!0?`checked`:``} />
            Enabled
          </label>
        </div>

        <fieldset class="watcher-fieldset">
          <legend>Discovery Backend</legend>
          <div class="watcher-radio-row">
            <label class="dash-checkbox-inline">
              <input type="radio" name="wf-backend" value="chrome" data-testid="watcher-form-backend-chrome" ${r===`chrome`?`checked`:``} />
              Chrome Extension (Live Session + GraphQL)
            </label>
            <label class="dash-checkbox-inline">
              <input type="radio" name="wf-backend" value="scraper_fs" data-testid="watcher-form-backend-scraper-fs" ${r===`scraper_fs`?`checked`:``} />
              upwork-scraper-fs (FlareSolverr + Proxy Rotation)
            </label>
          </div>
          ${s?`<div class="dash-banner dash-banner-error" data-testid="watcher-scraper-fs-warning">upwork-scraper-fs is unavailable: ${t(this.status?.scraper_fs_reason||`not configured`)}</div>`:``}

          <div class="watcher-form-grid">
            <div data-testid="watcher-chrome-settings" ${r===`chrome`?``:`hidden`}>
              <label>
                Chrome Source
                <select id="wf-source" data-testid="watcher-form-source">
                  <option value="search" ${(i.source??`search`)===`search`?`selected`:``}>search</option>
                  <option value="most_recent" ${i.source===`most_recent`?`selected`:``}>most_recent</option>
                  <option value="best_matches" ${i.source===`best_matches`?`selected`:``}>best_matches</option>
                  <option value="saved_jobs" ${i.source===`saved_jobs`?`selected`:``}>saved_jobs</option>
                </select>
              </label>
            </div>

            <div class="watcher-subgrid" data-testid="watcher-scraper-fs-settings" ${r===`scraper_fs`?``:`hidden`}>
              <label>
                scraper_fs Profile
                <input type="text" id="wf-sfs-profile" data-testid="watcher-form-sfs-profile" value="${t(i.scraper_fs_profile??``)}" placeholder="default" />
              </label>
              <label>
                Proxy Mode
                <select id="wf-sfs-proxy-mode" data-testid="watcher-form-sfs-proxy-mode">
                  <option value="rotation" ${(i.scraper_fs_proxy_mode??`rotation`)===`rotation`?`selected`:``}>rotation</option>
                  <option value="pinned" ${i.scraper_fs_proxy_mode===`pinned`?`selected`:``}>pinned</option>
                  <option value="direct" ${i.scraper_fs_proxy_mode===`direct`?`selected`:``}>direct</option>
                </select>
              </label>
              <label>
                Adapter
                <select id="wf-sfs-adapter" data-testid="watcher-form-sfs-adapter">
                  <option value="flaresolverr" ${(i.scraper_fs_adapter??`flaresolverr`)===`flaresolverr`?`selected`:``}>flaresolverr</option>
                  <option value="stealthy_session" ${i.scraper_fs_adapter===`stealthy_session`?`selected`:``}>stealthy_session</option>
                </select>
              </label>
            </div>

            <label class="dash-field-wide">
              Queries (comma-separated)
              <input type="text" id="wf-queries" data-testid="watcher-form-queries" value="${t(o)}" placeholder="go postgresql, typescript playwright" />
            </label>
            <label>
              Max Pages (1–20)
              <input type="number" id="wf-max-pages" data-testid="watcher-form-max-pages" value="${i.max_pages&&i.max_pages>0?i.max_pages:1}" min="1" max="20" />
            </label>
            <label>
              Results / Page
              <select id="wf-per-page" data-testid="watcher-form-per-page">
                <option value="" ${i.per_page?``:`selected`}>Default (10)</option>
                <option value="10" ${i.per_page===10?`selected`:``}>10</option>
                <option value="20" ${i.per_page===20?`selected`:``}>20</option>
                <option value="50" ${i.per_page===50?`selected`:``}>50</option>
              </select>
            </label>
            <label>
              Contract Type
              <select id="wf-contract-type" data-testid="watcher-form-contract-type">
                <option value="" ${i.contract_type?``:`selected`}>Any</option>
                <option value="hourly" ${i.contract_type===`hourly`?`selected`:``}>hourly</option>
                <option value="fixed" ${i.contract_type===`fixed`?`selected`:``}>fixed</option>
              </select>
            </label>
            <label>
              Budget Min ($)
              <input type="number" id="wf-budget-min" data-testid="watcher-form-budget-min" value="${i.budget_min??``}" min="0" />
            </label>
            <label>
              Budget Max ($)
              <input type="number" id="wf-budget-max" data-testid="watcher-form-budget-max" value="${i.budget_max??``}" min="0" />
            </label>
            <label>
              Rate Min ($/hr)
              <input type="number" id="wf-rate-min" data-testid="watcher-form-rate-min" value="${i.hourly_rate_min??``}" min="0" />
            </label>
            <label>
              Rate Max ($/hr)
              <input type="number" id="wf-rate-max" data-testid="watcher-form-rate-max" value="${i.hourly_rate_max??``}" min="0" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-disc-payment-verified" data-testid="watcher-form-discovery-payment-verified" ${i.payment_verified_only?`checked`:``} />
              Discovery: Payment Verified Only
            </label>
            <label class="dash-checkbox-inline dash-field-wide" title="When checked, Upwork Buddy appends up to 6 extra search queries derived from your active projects' tech stacks (e.g. Go, Python, TypeScript). Leave unchecked to search only your Queries — active-project scoring still runs automatically.">
              <input type="checkbox" id="wf-from-active-projects" data-testid="watcher-form-from-active-projects" ${i.from_active_projects?`checked`:``} />
              Also search Active Project tech stacks (+up to 6 extra queries)
            </label>
          </div>
          <div class="watcher-form-hint" data-testid="watcher-from-active-projects-hint" ${i.from_active_projects?``:`hidden`}>
            Heads up: this appends up to 6 extra Upwork searches derived from your active projects&apos; tech stacks (e.g. Go, TypeScript, Python) alongside your Queries. Leave unchecked to search only the Queries entered above (portfolio/active-project scoring still runs automatically).
          </div>
        </fieldset>

        <fieldset class="watcher-fieldset">
          <legend>Cadence &amp; Qualification Gates</legend>
          <div class="watcher-form-grid">
            <label>
              Interval (minutes)
              <input type="number" id="wf-interval" data-testid="watcher-form-interval" value="${n.interval_minutes??5}" min="1" />
            </label>
            <label>
              Jitter Ratio
              <input type="number" id="wf-jitter" data-testid="watcher-form-jitter" value="${n.jitter_ratio??.35}" min="0" max="0.9" step="0.05" />
            </label>
            <label>
              Active Hours (HH:MM-HH:MM)
              <input type="text" id="wf-active-hours" data-testid="watcher-form-active-hours" value="${t(n.active_hours??``)}" placeholder="08:00-22:00" />
            </label>
            <label>
              Min Score
              <input type="number" id="wf-min-score" data-testid="watcher-form-min-score" value="${n.min_score??75}" min="0" max="100" />
            </label>
            <label>
              Max Proposals
              <input type="number" id="wf-max-proposals" data-testid="watcher-form-max-proposals" value="${n.max_proposals??``}" min="0" />
            </label>
            <label>
              Max Posted Age (min)
              <input type="number" id="wf-max-age" data-testid="watcher-form-max-age" value="${n.max_posted_age_minutes??``}" min="0" />
            </label>
            <label>
              Max Connects/Job
              <input type="number" id="wf-max-connects" data-testid="watcher-form-max-connects" value="${n.max_connects_per_job??``}" min="0" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-require-payment-verified" data-testid="watcher-form-require-payment-verified" ${n.require_payment_verified?`checked`:``} />
              Require Payment Verified
            </label>
            <label>
              Required Keywords (comma-separated)
              <input type="text" id="wf-required-kw" data-testid="watcher-form-required-keywords" value="${t((n.required_keywords??[]).join(`, `))}" />
            </label>
            <label>
              Excluded Keywords (comma-separated)
              <input type="text" id="wf-exclude-kw" data-testid="watcher-form-exclude-keywords" value="${t((n.exclude_keywords??[]).join(`, `))}" />
            </label>
          </div>
        </fieldset>

        <fieldset class="watcher-fieldset">
          <legend>Action Mode &amp; Bid Strategy</legend>
          <div class="watcher-form-grid">
            <label>
              Action Mode
              <select id="wf-action-mode" data-testid="watcher-form-action-mode">
                <option value="alert_only" ${n.action_mode===`alert_only`?`selected`:``}>alert_only</option>
                <option value="draft_and_fill" ${n.action_mode===`draft_and_fill`?`selected`:``}>draft_and_fill</option>
                <option value="auto_submit" ${n.action_mode===`auto_submit`?`selected`:``}>auto_submit</option>
              </select>
            </label>
            <label>
              Hourly Rate ($)
              <input type="number" id="wf-bid-hourly" data-testid="watcher-form-bid-hourly-rate" value="${a.hourly_rate??``}" min="0" step="1" />
            </label>
            <label>
              Fixed Multiplier
              <input type="number" id="wf-bid-multiplier" data-testid="watcher-form-bid-fixed-multiplier" value="${a.fixed_multiplier??``}" min="0" step="0.05" />
            </label>
            <label>
              Min Fixed Bid ($)
              <input type="number" id="wf-bid-min-fixed" data-testid="watcher-form-bid-min-fixed" value="${a.min_fixed_bid??``}" min="0" />
            </label>
            <label>
              Max Fixed Bid ($)
              <input type="number" id="wf-bid-max-fixed" data-testid="watcher-form-bid-max-fixed" value="${a.max_fixed_bid??``}" min="0" />
            </label>
            <label>
              Rate Increase
              <input type="text" id="wf-bid-rate-increase" data-testid="watcher-form-bid-rate-increase" value="${t(a.rate_increase??``)}" placeholder="e.g. 5% every 6 months" />
            </label>
            <label>
              Boost Connects
              <input type="number" id="wf-bid-boost" data-testid="watcher-form-bid-boost-connects" value="${a.boost_connects??``}" min="0" />
            </label>
            <label>
              Auto-Submit Min Confidence
              <input type="number" id="wf-auto-confidence" data-testid="watcher-form-auto-submit-confidence" value="${n.auto_submit_min_confidence??.85}" min="0" max="1" step="0.05" />
            </label>
            <label>
              Max Reactions / Tick
              <input type="number" id="wf-max-reactions" data-testid="watcher-form-max-reactions" value="${n.max_reactions_per_tick??2}" min="1" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-fallback-screening" data-testid="watcher-form-fallback-screening" ${n.fallback_on_screening_questions===!1?``:`checked`} />
              Fallback on Screening Questions
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-seed-baseline" data-testid="watcher-form-seed-baseline" ${n.seed_baseline_on_first_run===!1?``:`checked`} />
              Seed Baseline on First Run
            </label>
          </div>
        </fieldset>

        <div class="watcher-form-actions">
          <button type="submit" class="dash-btn-primary" data-testid="watcher-form-save-btn">
            ${e?`Save Changes`:`Create Watch Rule`}
          </button>
          <button type="button" class="dash-btn-secondary" data-testid="watcher-form-cancel-btn">Cancel</button>
        </div>
      </form>
    `}renderInspector(){let e=this.rules.find(e=>e.id===this.inspectedRuleId),n=e?e.name:`Rule #${this.inspectedRuleId}`,r=this.inspectorLoading?`<p class="dash-muted">Loading runs and events...</p>`:this.inspectedRuns.length===0?`<p class="dash-muted">No runs recorded yet.</p>`:`<ul class="watcher-inspector-list" data-testid="watcher-runs-list">
              ${this.inspectedRuns.map(e=>`
                  <li>
                    <strong>#${e.id}</strong> [${t(e.status)}] (${t(e.discovery_backend)} / ${t(e.triggered_by)})
                    — scraped ${e.scraped_count}, new ${e.new_jobs_count}, qualified ${e.qualified_count},
                    drafted ${e.drafted_count}, filled ${e.filled_count}, submitted ${e.submitted_count}, alerted ${e.alerted_count}
                    <small>${t(e.started_at)}</small>
                    ${e.error_message?`<span class="watcher-error-text">${t(e.error_message)}</span>`:``}
                  </li>
                `).join(``)}
            </ul>`,i=this.inspectorLoading?``:this.inspectedEvents.length===0?`<p class="dash-muted">No job events recorded yet.</p>`:`<ul class="watcher-inspector-list" data-testid="watcher-events-list">
              ${this.inspectedEvents.map(e=>`
                  <li>
                    <strong>${t(e.job_title||e.upwork_job_id||`Job #${e.job_id}`)}</strong>
                    — stage: <code>${t(e.stage)}</code>
                    ${e.confidence==null?``:` (conf ${e.confidence.toFixed(2)})`}
                    ${e.decision_reason?` — ${t(e.decision_reason)}`:``}
                    ${e.error_message?`<span class="watcher-error-text">${t(e.error_message)}</span>`:``}
                  </li>
                `).join(``)}
            </ul>`;return`
      <section class="watcher-inspector" data-testid="watcher-inspector">
        <div class="watcher-inspector-header">
          <strong>Runs &amp; Events: ${t(n)}</strong>
          <button type="button" class="dash-btn-sm" data-testid="watcher-inspector-close-btn">Close</button>
        </div>
        <div class="watcher-inspector-cols">
          <div>
            <h5>Recent Runs (${this.inspectedRuns.length})</h5>
            ${r}
          </div>
          <div>
            <h5>Recent Events (${this.inspectedEvents.length})</h5>
            ${i}
          </div>
        </div>
      </section>
    `}renderNotificationSettings(){let e=this.notifConfig,n=new Set(e?.notify_events??[]),r=e?.has_webhook_secret?`Configured (leave blank to keep)`:`Optional HMAC secret`,i=e?.has_telegram_bot_token?`Configured (leave blank to keep)`:`Bot token from @BotFather`,a=this.testResult?`<div class="dash-banner ${this.testResult.ok?`dash-banner-success`:`dash-banner-error`}" data-testid="notif-test-result">
          Test ${this.testResult.ok?`succeeded`:`failed`}:
          ${Object.entries(this.testResult.results??{}).map(([e,n])=>{let r=!!(n.sent??n.ok);return`${t(e)}: ${r?`sent`:`failed (${t(n.error??`error`)})`}`}).join(` | `)}
        </div>`:``;return`
      <section class="watcher-notifications" data-testid="notifications-settings">
        <h4 class="watchers-section-title">Notification Channels</h4>
        <form id="watcher-notif-form" class="watcher-notif-form">
          <div class="watcher-form-grid">
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-chrome" data-testid="notif-chrome-enabled" ${e?.chrome_notifications_enabled?`checked`:``} />
              Chrome Desktop Notifications
            </label>

            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-webhook" data-testid="notif-webhook-enabled" ${e?.webhook_enabled?`checked`:``} />
              Webhook Enabled
            </label>
            <label class="dash-field-wide">
              Webhook URL
              <input type="text" id="notif-webhook-url" data-testid="notif-webhook-url" value="${t(e?.webhook_url??``)}" placeholder="https://example.com/webhook" />
            </label>
            <label>
              Webhook Secret
              <input type="password" id="notif-webhook-secret" data-testid="notif-webhook-secret" autocomplete="new-password" value="" placeholder="${t(r)}" />
            </label>
            ${e?.has_webhook_secret?`<label class="dash-checkbox-inline">
                    <input type="checkbox" id="notif-clear-webhook-secret" data-testid="notif-clear-webhook-secret" />
                    Clear Webhook Secret
                  </label>`:``}

            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-telegram" data-testid="notif-telegram-enabled" ${e?.telegram_enabled?`checked`:``} />
              Telegram Enabled
            </label>
            <label>
              Telegram Bot Token
              <input type="password" id="notif-telegram-token" data-testid="notif-telegram-token" autocomplete="new-password" value="" placeholder="${t(i)}" />
            </label>
            <label>
              Telegram Chat ID
              <div class="watcher-inline-input-row">
                <input type="text" id="notif-telegram-chat-id" data-testid="notif-telegram-chat-id" value="${t(e?.telegram_chat_id??``)}" placeholder="123456789" />
                <button type="button" class="dash-btn-sm" data-testid="notif-telegram-detect-btn" ${this.detectingTelegramChat?`disabled`:``}>
                  ${this.detectingTelegramChat?`Detecting...`:`Detect Chat ID`}
                </button>
              </div>
            </label>
            ${e?.has_telegram_bot_token?`<label class="dash-checkbox-inline">
                    <input type="checkbox" id="notif-clear-telegram-token" data-testid="notif-clear-telegram-token" />
                    Clear Telegram Token
                  </label>`:``}
          </div>

          ${this.detectedTelegramChats.length>0?`<div class="watcher-telegram-chats" data-testid="notif-telegram-chats">
                  <span class="watcher-events-label">Detected Telegram chats (click to use &amp; save):</span>
                  <div class="watcher-telegram-chat-list">
                    ${this.detectedTelegramChats.map(e=>`
                        <button type="button" class="dash-btn-sm js-select-telegram-chat" data-testid="notif-telegram-chat-option" data-chat-id="${t(e.chat_id)}" data-display-name="${t(e.display_name)}">
                          ${t(e.display_name)} (<code>${t(e.chat_id)}</code>)${e.last_text?` — "${t(e.last_text)}"`:``}
                        </button>
                      `).join(``)}
                  </div>
                </div>`:this.detectedTelegramHint?`<div class="watcher-form-hint" data-testid="notif-telegram-detect-hint">${t(this.detectedTelegramHint)}</div>`:``}

          <div class="watcher-notify-events">
            <span class="watcher-events-label">Notify on events:</span>
            ${ct.map(e=>`
              <label class="dash-checkbox-inline">
                <input type="checkbox" class="js-notif-event" value="${t(e.id)}" data-testid="notif-event-${t(e.id)}" ${n.has(e.id)?`checked`:``} />
                ${t(e.label)}
              </label>
            `).join(``)}
          </div>

          <div class="watcher-notif-actions">
            <button type="submit" class="dash-btn-primary" data-testid="notif-save-btn">Save Notification Settings</button>
            <select id="notif-test-channel" data-testid="notif-test-channel" aria-label="Test notification channel">
              <option value="all">All Channels</option>
              <option value="chrome">Chrome</option>
              <option value="webhook">Webhook</option>
              <option value="telegram">Telegram</option>
            </select>
            <button type="button" class="dash-btn-secondary" data-testid="notif-test-btn">Send Test Notification</button>
          </div>
          ${a}
        </form>
      </section>
    `}bindEvents(){this.rootEl.querySelector(`[data-testid="new-watcher-btn"]`)?.addEventListener(`click`,()=>{this.editingRuleId=null,this.formBackend=`chrome`,this.formOpen=!0,this.render()}),this.rootEl.querySelector(`[data-testid="refresh-watchers-btn"]`)?.addEventListener(`click`,()=>void this.refreshAll()),this.rootEl.querySelectorAll(`input[name="wf-backend"]`).forEach(e=>{e.addEventListener(`change`,()=>{if(e.checked){this.formBackend=e.value===`scraper_fs`?`scraper_fs`:`chrome`;let t=this.rootEl.querySelector(`[data-testid="watcher-chrome-settings"]`),n=this.rootEl.querySelector(`[data-testid="watcher-scraper-fs-settings"]`);t&&(t.hidden=this.formBackend!==`chrome`),n&&(n.hidden=this.formBackend!==`scraper_fs`);let r=this.rootEl.querySelector(`[data-testid="watcher-scraper-fs-warning"]`);if(this.formBackend===`scraper_fs`&&this.status?.scraper_fs_available===!1){if(!r){let e=document.createElement(`div`);e.className=`dash-banner dash-banner-error`,e.dataset.testid=`watcher-scraper-fs-warning`,e.textContent=`upwork-scraper-fs is unavailable: ${this.status?.scraper_fs_reason||`not configured`}`,this.rootEl.querySelector(`.watcher-radio-row`)?.insertAdjacentElement(`afterend`,e)}}else r?.remove()}})}),this.rootEl.querySelector(`#wf-from-active-projects`)?.addEventListener(`change`,e=>{let t=e.currentTarget,n=this.rootEl.querySelector(`[data-testid="watcher-from-active-projects-hint"]`);n&&(n.hidden=!t.checked)}),this.rootEl.querySelector(`[data-testid="watcher-form-cancel-btn"]`)?.addEventListener(`click`,()=>{this.formOpen=!1,this.editingRuleId=null,this.render()}),this.rootEl.querySelector(`#watcher-rule-form`)?.addEventListener(`submit`,e=>{e.preventDefault(),this.handleSaveRule()}),this.rootEl.querySelectorAll(`.js-watcher-toggle`).forEach(e=>{e.addEventListener(`click`,()=>{let t=Number(e.dataset.id),n=this.rules.find(e=>e.id===t);n&&this.handleToggle(t,!n.enabled)})}),this.rootEl.querySelectorAll(`.js-watcher-run`).forEach(e=>{e.addEventListener(`click`,()=>void this.handleRun(Number(e.dataset.id),!1))}),this.rootEl.querySelectorAll(`.js-watcher-dry-run`).forEach(e=>{e.addEventListener(`click`,()=>void this.handleRun(Number(e.dataset.id),!0))}),this.rootEl.querySelectorAll(`.js-watcher-resume`).forEach(e=>{e.addEventListener(`click`,()=>void this.handleResume(Number(e.dataset.id)))}),this.rootEl.querySelectorAll(`.js-watcher-inspect`).forEach(e=>{e.addEventListener(`click`,()=>void this.handleInspect(Number(e.dataset.id)))}),this.rootEl.querySelectorAll(`.js-watcher-edit`).forEach(e=>{e.addEventListener(`click`,()=>{let t=Number(e.dataset.id),n=this.rules.find(e=>e.id===t);n&&(this.editingRuleId=t,this.formBackend=n.discovery_backend,this.formOpen=!0,this.render())})}),this.rootEl.querySelectorAll(`.js-watcher-delete`).forEach(e=>{e.addEventListener(`click`,()=>void this.handleDelete(Number(e.dataset.id)))}),this.rootEl.querySelector(`[data-testid="watcher-inspector-close-btn"]`)?.addEventListener(`click`,()=>{this.inspectedRuleId=null,this.inspectedRuns=[],this.inspectedEvents=[],this.render()}),this.rootEl.querySelector(`#watcher-notif-form`)?.addEventListener(`submit`,e=>{e.preventDefault(),this.handleSaveNotifications()}),this.rootEl.querySelector(`[data-testid="notif-test-btn"]`)?.addEventListener(`click`,()=>void this.handleTestNotification()),this.rootEl.querySelector(`[data-testid="notif-telegram-detect-btn"]`)?.addEventListener(`click`,()=>void this.handleDetectTelegramChat()),this.rootEl.querySelectorAll(`.js-select-telegram-chat`).forEach(e=>{e.addEventListener(`click`,()=>{let t=e.dataset.chatId?.trim()??``,n=e.dataset.displayName?.trim()??t;t&&this.handleSelectDetectedTelegramChat(t,n)})})}val(e){return this.rootEl.querySelector(e)?.value??``}checked(e){return this.rootEl.querySelector(e)?.checked??!1}async handleSaveRule(){let e=this.val(`#wf-name`).trim();if(!e){this.setBanner(`Rule name is required.`,!0),this.render();return}let t=this.editingRuleId===null?void 0:this.rules.find(e=>e.id===this.editingRuleId),n=Y(this.val(`#wf-max-pages`)),r=n===null?1:Math.min(20,Math.max(1,n)),i=Y(this.val(`#wf-per-page`)),a=i===10||i===20||i===50?i:void 0,o={...t?.discovery_config??{},source:this.val(`#wf-source`)||`search`,queries:lt(this.val(`#wf-queries`)),max_pages:r,contract_type:this.val(`#wf-contract-type`),budget_min:Y(this.val(`#wf-budget-min`)),budget_max:Y(this.val(`#wf-budget-max`)),hourly_rate_min:X(this.val(`#wf-rate-min`)),hourly_rate_max:X(this.val(`#wf-rate-max`)),payment_verified_only:this.checked(`#wf-disc-payment-verified`),from_active_projects:this.checked(`#wf-from-active-projects`),scraper_fs_profile:this.val(`#wf-sfs-profile`).trim(),scraper_fs_proxy_mode:this.val(`#wf-sfs-proxy-mode`)||`rotation`,scraper_fs_adapter:this.val(`#wf-sfs-adapter`)||`flaresolverr`};a===void 0?delete o.per_page:o.per_page=a;let s={name:e,description:this.val(`#wf-description`).trim(),enabled:this.checked(`#wf-enabled`),discovery_backend:this.formBackend,discovery_config:o,interval_minutes:Y(this.val(`#wf-interval`))??5,jitter_ratio:X(this.val(`#wf-jitter`))??.35,active_hours:this.val(`#wf-active-hours`).trim(),min_score:(()=>{let e=X(this.val(`#wf-min-score`));return e===null?75:Math.round(e)})(),max_proposals:Y(this.val(`#wf-max-proposals`)),max_posted_age_minutes:Y(this.val(`#wf-max-age`)),max_connects_per_job:Y(this.val(`#wf-max-connects`)),require_payment_verified:this.checked(`#wf-require-payment-verified`),required_keywords:lt(this.val(`#wf-required-kw`)),exclude_keywords:lt(this.val(`#wf-exclude-kw`)),action_mode:this.val(`#wf-action-mode`)||`draft_and_fill`,bid_strategy:{hourly_rate:X(this.val(`#wf-bid-hourly`)),fixed_multiplier:X(this.val(`#wf-bid-multiplier`)),min_fixed_bid:X(this.val(`#wf-bid-min-fixed`)),max_fixed_bid:X(this.val(`#wf-bid-max-fixed`)),rate_increase:this.val(`#wf-bid-rate-increase`).trim(),boost_connects:Y(this.val(`#wf-bid-boost`))},auto_submit_min_confidence:X(this.val(`#wf-auto-confidence`))??.85,fallback_on_screening_questions:this.checked(`#wf-fallback-screening`),max_reactions_per_tick:Y(this.val(`#wf-max-reactions`))??2,seed_baseline_on_first_run:this.checked(`#wf-seed-baseline`)};try{this.editingRuleId===null?(await this.api.createWatcher(s),this.setBanner(`Created watch rule "${e}".`)):(await this.api.updateWatcher(this.editingRuleId,s),this.setBanner(`Updated watch rule "${e}".`)),this.formOpen=!1,this.editingRuleId=null,await this.refreshAll()}catch(e){if(this.handleAuthOrError(e,`Failed to save watch rule`))return;this.render()}}async handleToggle(e,t){try{await this.api.toggleWatcher(e,t),this.setBanner(`Rule #${e} ${t?`enabled`:`disabled`}.`),await this.refreshAll()}catch(e){if(this.handleAuthOrError(e,`Failed to toggle rule`))return;this.render()}}async handleResume(e){try{await this.api.resumeWatcher(e),this.setBanner(`Rule #${e} resumed.`),await this.refreshAll()}catch(e){if(this.handleAuthOrError(e,`Failed to resume rule`))return;this.render()}}async handleRun(e,t){if(this.runningRuleIds.has(e))return;let n=this.rules.find(t=>t.id===e),r=n?`"${n.name}"`:`Rule #${e}`;this.runningRuleIds.add(e),this.setBanner(`Running ${t?`dry run`:`watcher`} for ${r}...`),this.render();try{let n=await this.api.runWatcher(e,{dry_run:t});if(this.destroyed)return;this.runningRuleIds.delete(e);let r=n.run;if(r.status===`seeded`)this.setBanner(`Run #${r.id} (baseline seeded): scraped ${r.scraped_count} existing job(s) so only newly posted jobs trigger future runs. Click "Run Now" later or disable "Seed Baseline on First Run" to react immediately.`);else if(r.status===`skipped_busy`)this.setBanner(`Run #${r.id} (skipped — tab busy): automation tab was busy and will retry on the next tick.`);else if(t){let e=Array.isArray(n.events)?n.events.length:0;this.setBanner(`Dry run (${r.status}): scraped ${r.scraped_count}, new ${r.new_jobs_count}, qualified ${r.qualified_count}, preview events ${e} (no jobs or proposals saved).`)}else this.setBanner(`Run #${r.id} (${r.status}): scraped ${r.scraped_count}, new ${r.new_jobs_count}, qualified ${r.qualified_count}, drafted ${r.drafted_count}, filled ${r.filled_count}, submitted ${r.submitted_count}, alerted ${r.alerted_count}.`);this.inspectedRuleId===e?await this.handleInspect(e):await this.refreshAll()}catch(t){if(this.runningRuleIds.delete(e),this.handleAuthOrError(t,`Failed to trigger watcher run`))return;this.render()}}async handleDelete(e){try{await this.api.deleteWatcher(e),this.inspectedRuleId===e&&(this.inspectedRuleId=null),this.setBanner(`Deleted rule #${e}.`),await this.refreshAll()}catch(e){if(this.handleAuthOrError(e,`Failed to delete rule`))return;this.render()}}async handleInspect(e){this.inspectedRuleId=e,this.inspectorLoading=!0,this.render();try{let[t,n]=await Promise.all([this.api.listWatcherRuns(e,{limit:20,offset:0}),this.api.listWatcherEvents(e,{limit:50,offset:0})]);if(this.destroyed)return;this.inspectedRuns=Array.isArray(t.runs)?t.runs:[],this.inspectedEvents=Array.isArray(n.events)?n.events:[]}catch(e){if(this.handleAuthOrError(e,`Failed to load runs & events`))return}finally{this.inspectorLoading=!1,this.destroyed||this.render()}}async handleSaveNotifications(){let e=Array.from(this.rootEl.querySelectorAll(`.js-notif-event`)).filter(e=>e.checked).map(e=>e.value),t={chrome_notifications_enabled:this.checked(`#notif-chrome`),webhook_enabled:this.checked(`#notif-webhook`),webhook_url:this.val(`#notif-webhook-url`).trim(),telegram_enabled:this.checked(`#notif-telegram`),telegram_chat_id:this.val(`#notif-telegram-chat-id`).trim(),notify_events:e},n=this.val(`#notif-webhook-secret`).trim();n?t.webhook_secret=n:this.checked(`#notif-clear-webhook-secret`)&&(t.clear_webhook_secret=!0);let r=this.val(`#notif-telegram-token`).trim();r?t.telegram_bot_token=r:this.checked(`#notif-clear-telegram-token`)&&(t.clear_telegram_bot_token=!0);try{let e=await this.api.updateNotificationConfig(t);if(this.destroyed)return;this.notifConfig=e.config,this.setBanner(`Notification settings saved.`),this.render()}catch(e){if(this.handleAuthOrError(e,`Failed to save notification settings`))return;this.render()}}async handleTestNotification(){let e=this.val(`#notif-test-channel`)||`all`;try{let t=await this.api.testNotifications(e);if(this.destroyed)return;this.testResult=t,this.render()}catch(e){if(this.handleAuthOrError(e,`Failed to send test notification`))return;this.render()}}async handleDetectTelegramChat(){if(this.detectingTelegramChat)return;let e=this.val(`#notif-telegram-token`).trim();this.pendingTelegramToken=e,this.detectingTelegramChat=!0,this.detectedTelegramHint=``,this.setBanner(`Querying Telegram bot updates to detect chat ID...`),this.render();try{let t=await this.api.detectTelegramChat({...e?{telegram_bot_token:e}:{},auto_save:!0});if(this.destroyed)return;if(this.detectingTelegramChat=!1,this.detectedTelegramChats=Array.isArray(t.chats)?t.chats:[],this.detectedTelegramHint=t.hint??``,t.saved&&t.config&&this.detectedTelegramChats.length===1){this.notifConfig=t.config,this.pendingTelegramToken=``;let e=this.detectedTelegramChats[0];this.setBanner(`Detected and saved Telegram chat: ${e.display_name} (ID: ${e.chat_id}). Click "Send Test Notification" to verify.`)}else this.detectedTelegramChats.length>1?this.setBanner(`Found ${this.detectedTelegramChats.length} Telegram chats. Select the one you want to use below.`):this.setBanner(this.detectedTelegramHint||`No recent messages found. Send /start to your bot in Telegram, then click Detect Chat ID again.`,!0);this.render()}catch(e){if(this.detectingTelegramChat=!1,this.handleAuthOrError(e,`Failed to detect Telegram chat ID`))return;this.render()}}async handleSelectDetectedTelegramChat(e,t){let n={telegram_chat_id:e,telegram_enabled:!0},r=this.val(`#notif-telegram-token`).trim()||this.pendingTelegramToken;r&&(n.telegram_bot_token=r);try{let r=await this.api.updateNotificationConfig(n);if(this.destroyed)return;this.notifConfig=r.config,this.pendingTelegramToken=``,this.setBanner(`Saved Telegram chat: ${t} (ID: ${e}). Click "Send Test Notification" to verify.`),this.render()}catch(e){if(this.handleAuthOrError(e,`Failed to save selected Telegram chat ID`))return;this.render()}}},ft=class extends Error{status;constructor(e,t){super(t),this.name=`ApiError`,this.status=e}};function Z(e,t=0){return typeof e==`number`&&Number.isFinite(e)?e:t}function pt(e){return e instanceof ft&&e.status===401||e instanceof Error&&/\b401\b|unauthorized/i.test(e.message)}var mt={max_batch_size:25,default_mode:`full`,default_force:!1,skip_detail_if_present:!0,require_details:!1,max_concurrency:2,default_model:``,default_effort:``,confirm_threshold:5,wait_timeout_seconds:60,web_ui_enabled:!0,web_session_ttl_minutes:720},ht=class{root;transport;surface;getExtensionRuntimeStatus;onUnauthorized;config={...mt};allJobs=[];searchRuns=[];activeProjects=[];activeBatchDetail=null;batchItemsExpanded=!1;batchBannerDismissedId=null;selectedRunId=``;filterQuery=``;filterFit=``;filterEnrichment=``;filterContract=``;filterMatchedProject=``;filterMinScore=``;pollTimer=null;isPollInFlight=!1;pollTokenCounter=0;batchStateSeq=0;loadJobsSeq=0;destroyed=!1;wsPillEl;projectsPillEl;searchRunSelectEl;toggleSearchPanelBtn;searchPanelEl;toggleWatchersPanelBtn;watchersBadgeEl;watchersPanelEl;errorBannerEl;batchBannerEl;filterQueryInput;filterFitSelect;filterEnrichmentSelect;filterContractSelect;filterMatchedProjectSelect;filterMinScoreInput;bulkBarEl;bulkSummaryEl;bulkModeSelect;bulkForceCheckbox;bulkModelInput;bulkEffortSelect;confirmModalEl;confirmSummaryEl;table;drawer;watchersPanel=null;watchersPanelInitialized=!1;constructor(e){this.root=e.root,this.transport=e.transport,this.surface=e.surface,this.getExtensionRuntimeStatus=e.getExtensionRuntimeStatus,this.onUnauthorized=e.onUnauthorized}async init(){this.destroyed||(this.readInitialUrlParams(),this.mountSkeleton(),this.bindStaticEvents(),await Promise.all([this.loadRuntimeStatus(),this.loadEnrichmentConfig(),this.loadActiveProjects(),this.loadSearchRuns(),this.loadWatchersStatus()]),this.destroyed||(this.applyInitialFilterControlValues(),await Promise.all([this.loadJobs(),this.loadActiveBatches()])))}destroy(){this.destroyed=!0,this.batchStateSeq+=1,this.loadJobsSeq+=1,this.isPollInFlight=!1,this.pollTokenCounter+=1,this.stopBatchPolling(),this.drawer?.destroy(),this.watchersPanel?.destroy()}readInitialUrlParams(){try{let e=new URLSearchParams(window.location.search),t=e.get(`run`),n=e.get(`fit`),r=e.get(`q`);t&&/^\d+$/.test(t)&&(this.selectedRunId=t),n&&(this.filterFit=n),r&&(this.filterQuery=r)}catch{}}mountSkeleton(){this.root.innerHTML=`
      <div class="dash-shell">
        <header id="dash-topbar" class="dash-topbar">
          <div class="dash-topbar-left">
            <h1 class="dash-brand">Upwork Buddy</h1>
            <span class="dash-surface-badge">${this.surface===`extension`?`Extension Tab`:`Web Dashboard`}</span>
            <span id="dash-ws-pill" data-testid="ws-status-pill" class="dash-pill">Connecting...</span>
            <span id="dash-projects-pill" data-testid="active-projects-pill" class="dash-pill">0 active</span>
          </div>
          <div class="dash-topbar-right">
            <label class="dash-inline-label">
              Search Run:
              <select id="dash-search-run-select" data-testid="search-run-select">
                <option value="">All Runs</option>
              </select>
            </label>
            <button type="button" id="dash-toggle-watchers-btn" data-testid="toggle-watchers-panel-btn" class="dash-btn-secondary">
              Watchers <span id="dash-watchers-badge" data-testid="watchers-status-badge" class="dash-badge-count">0</span>
            </button>
            <button type="button" id="dash-toggle-search-btn" data-testid="toggle-search-panel-btn" class="dash-btn-secondary">
              Run New Search
            </button>
          </div>
        </header>

        <section id="dash-search-panel" data-testid="search-panel" class="dash-search-panel" hidden>
          <div class="dash-search-panel-header">
            <div class="dash-search-panel-title">
              <strong>Multi-Criteria Upwork Search</strong>
              <span class="dash-zero-llm-badge">0 LLM tokens</span>
            </div>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-match-active-cb" data-testid="match-active-projects-checkbox" />
              Match Active Projects (tech stack only, NDA-safe)
            </label>
          </div>
          <form id="dash-search-form" class="dash-search-grid">
            <label class="dash-field-wide">
              Queries (comma or newline separated)
              <input type="text" id="dash-search-queries" data-testid="search-queries-input" placeholder="e.g. go postgresql, typescript playwright" />
            </label>
            <label>
              Source
              <select id="dash-search-source" data-testid="search-source-select">
                <option value="search">Search</option>
                <option value="best_matches">Best Matches</option>
                <option value="most_recent">Most Recent</option>
                <option value="saved_jobs">Saved Jobs</option>
              </select>
            </label>
            <label>
              Contract Type
              <select id="dash-search-contract" data-testid="search-contract-select">
                <option value="">Any</option>
                <option value="hourly">Hourly</option>
                <option value="fixed">Fixed</option>
              </select>
            </label>
            <label>
              Min Rate ($/hr)
              <input type="number" id="dash-search-rate-min" data-testid="search-rate-min" min="0" step="1" placeholder="70" />
            </label>
            <label>
              Max Rate ($/hr)
              <input type="number" id="dash-search-rate-max" data-testid="search-rate-max" min="0" step="1" placeholder="150" />
            </label>
            <label>
              Min Budget ($)
              <input type="number" id="dash-search-budget-min" data-testid="search-budget-min" min="0" step="50" placeholder="500" />
            </label>
            <label>
              Max Budget ($)
              <input type="number" id="dash-search-budget-max" data-testid="search-budget-max" min="0" step="50" placeholder="10000" />
            </label>
            <label>
              Max Pages
              <input type="number" id="dash-search-max-pages" data-testid="search-max-pages" min="1" max="20" value="1" />
            </label>
            <label>
              Run Label
              <input type="text" id="dash-search-run-label" data-testid="search-run-label" placeholder="optional label" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-search-payment-verified" data-testid="search-payment-verified" />
              Payment Verified Only
            </label>
            <div class="dash-search-submit-wrap">
              <button type="submit" id="dash-run-search-submit" data-testid="run-search-submit-btn" class="dash-btn-primary">
                Run Search (0 LLM tokens)
              </button>
              <span id="dash-search-panel-status" class="dash-muted"></span>
            </div>
          </form>
        </section>

        <section id="dash-watchers-panel" data-testid="watchers-panel" class="dash-watchers-panel" hidden></section>

        <div id="dash-error-banner" class="dash-banner dash-banner-error" role="alert" hidden></div>
        <div id="dash-batch-banner" class="dash-batch-banner" hidden></div>

        <section id="dash-filter-bar" class="dash-filter-bar">
          <input type="search" id="dash-filter-query" data-testid="filter-query-input" placeholder="Search jobs by title, skills, description..." />
          <select id="dash-filter-fit" data-testid="filter-fit-select" aria-label="Filter by fit">
            <option value="">All Fits</option>
            <option value="hot">Hot</option>
            <option value="ready">Ready</option>
            <option value="review">Review</option>
            <option value="skip">Skip</option>
          </select>
          <select id="dash-filter-enrichment" data-testid="filter-enrichment-select" aria-label="Filter by enrichment state">
            <option value="">All Enrichment States</option>
            <option value="none">Unenriched</option>
            <option value="detail_only">Details Only</option>
            <option value="queued">Queued</option>
            <option value="scraping_details">Scraping Details</option>
            <option value="analyzing">Analyzing</option>
            <option value="completed">AI Enriched</option>
            <option value="failed">Failed</option>
          </select>
          <select id="dash-filter-contract" data-testid="filter-contract-select" aria-label="Filter by contract type">
            <option value="">All Types</option>
            <option value="hourly">Hourly</option>
            <option value="fixed">Fixed</option>
          </select>
          <select id="dash-filter-matched-project" data-testid="filter-matched-project-select" aria-label="Filter by matched project">
            <option value="">All Matched Projects</option>
          </select>
          <input type="number" id="dash-filter-min-score" data-testid="filter-min-score-input" min="0" max="100" placeholder="Min score" />
          <button type="button" id="dash-refresh-btn" data-testid="refresh-jobs-btn" class="dash-btn-secondary">Refresh</button>
        </section>

        <section id="dash-bulk-bar" data-testid="bulk-selection-bar" class="dash-bulk-bar" hidden>
          <div class="dash-bulk-left">
            <strong id="dash-bulk-summary" data-testid="bulk-selection-summary">0 selected</strong>
          </div>
          <div class="dash-bulk-controls">
            <label class="dash-inline-label">
              Mode:
              <select id="dash-bulk-mode" data-testid="bulk-mode-select">
                <option value="full">Full (Details + AI)</option>
                <option value="ai_only">AI Only</option>
                <option value="detail_only">Detail Only (0 LLM)</option>
              </select>
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-bulk-force" data-testid="bulk-force-checkbox" />
              Force re-enrich
            </label>
            <input type="text" id="dash-bulk-model" data-testid="bulk-model-input" placeholder="Model override (optional)" />
            <select id="dash-bulk-effort" data-testid="bulk-effort-select" aria-label="Effort override">
              <option value="">Effort: Default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
            <button type="button" id="dash-enrich-selected-btn" data-testid="enrich-selected-btn" class="dash-btn-primary">
              Enrich Selected
            </button>
            <button type="button" id="dash-clear-selection-btn" data-testid="bulk-clear-selection-btn" class="dash-btn-secondary">
              Clear
            </button>
          </div>
        </section>

        <div id="dash-table-wrap" class="dash-table-wrap"></div>
        <div id="dash-pagination" class="dash-pagination"></div>
        <div id="dash-drawer" class="dash-drawer-root" hidden></div>

        <div id="dash-confirm-modal" class="dash-modal-overlay" hidden>
          <div class="dash-modal" role="dialog" aria-modal="true" aria-label="Confirm Batch Enrichment" data-testid="confirm-enrich-dialog">
            <h3>Confirm Batch AI Enrichment</h3>
            <p id="dash-confirm-summary"></p>
            <div class="dash-modal-actions">
              <button type="button" id="dash-confirm-cancel-btn" data-testid="confirm-enrich-cancel-btn" class="dash-btn-secondary">Cancel</button>
              <button type="button" id="dash-confirm-proceed-btn" data-testid="confirm-enrich-proceed-btn" class="dash-btn-primary">Confirm Enrich</button>
            </div>
          </div>
        </div>
      </div>
    `,this.wsPillEl=this.mustQuery(`#dash-ws-pill`),this.projectsPillEl=this.mustQuery(`#dash-projects-pill`),this.searchRunSelectEl=this.mustQuery(`#dash-search-run-select`),this.toggleSearchPanelBtn=this.mustQuery(`#dash-toggle-search-btn`),this.searchPanelEl=this.mustQuery(`#dash-search-panel`),this.toggleWatchersPanelBtn=this.mustQuery(`#dash-toggle-watchers-btn`),this.watchersBadgeEl=this.mustQuery(`#dash-watchers-badge`),this.watchersPanelEl=this.mustQuery(`#dash-watchers-panel`),this.errorBannerEl=this.mustQuery(`#dash-error-banner`),this.batchBannerEl=this.mustQuery(`#dash-batch-banner`),this.filterQueryInput=this.mustQuery(`#dash-filter-query`),this.filterFitSelect=this.mustQuery(`#dash-filter-fit`),this.filterEnrichmentSelect=this.mustQuery(`#dash-filter-enrichment`),this.filterContractSelect=this.mustQuery(`#dash-filter-contract`),this.filterMatchedProjectSelect=this.mustQuery(`#dash-filter-matched-project`),this.filterMinScoreInput=this.mustQuery(`#dash-filter-min-score`),this.bulkBarEl=this.mustQuery(`#dash-bulk-bar`),this.bulkSummaryEl=this.mustQuery(`#dash-bulk-summary`),this.bulkModeSelect=this.mustQuery(`#dash-bulk-mode`),this.bulkForceCheckbox=this.mustQuery(`#dash-bulk-force`),this.bulkModelInput=this.mustQuery(`#dash-bulk-model`),this.bulkEffortSelect=this.mustQuery(`#dash-bulk-effort`),this.confirmModalEl=this.mustQuery(`#dash-confirm-modal`),this.confirmSummaryEl=this.mustQuery(`#dash-confirm-summary`),this.table=new Ze({tableWrap:this.mustQuery(`#dash-table-wrap`),paginationWrap:this.mustQuery(`#dash-pagination`),callbacks:{onInspectJob:e=>this.drawer.open(e),onEnrichSingleJob:e=>{this.startBatchEnrich([e.id],{mode:this.config.default_mode,force:U(e)})},onStatusChange:(e,t)=>{this.handleStatusChange(e,t)},onSelectionChange:()=>{this.updateBulkSelectionBar()}}}),this.drawer=new et({container:this.mustQuery(`#dash-drawer`),callbacks:{onEnrichJob:e=>this.enrichJobFromDrawer(e),onSaveProposalDraft:e=>this.saveProposalDraftFromDrawer(e)}})}mustQuery(e){let t=this.root.querySelector(e);if(!t)throw Error(`Dashboard skeleton missing ${e}`);return t}applyInitialFilterControlValues(){this.filterQueryInput.value=this.filterQuery,this.filterFitSelect.value=this.filterFit,this.filterEnrichmentSelect.value=this.filterEnrichment,this.filterContractSelect.value=this.filterContract,this.filterMatchedProjectSelect.value=this.filterMatchedProject,this.filterMinScoreInput.value=this.filterMinScore,this.selectedRunId&&(this.searchRunSelectEl.value=this.selectedRunId)}bindStaticEvents(){this.toggleSearchPanelBtn.addEventListener(`click`,()=>{this.searchPanelEl.hidden=!this.searchPanelEl.hidden}),this.toggleWatchersPanelBtn.addEventListener(`click`,()=>{let e=this.watchersPanelEl.hidden;this.watchersPanelEl.hidden=!e,e&&this.ensureWatchersPanelInit()}),this.searchRunSelectEl.addEventListener(`change`,()=>{this.selectedRunId=this.searchRunSelectEl.value,this.loadJobs()}),this.mustQuery(`#dash-search-form`).addEventListener(`submit`,e=>{e.preventDefault(),this.handleRunSearchSubmit()}),this.filterQueryInput.addEventListener(`input`,()=>{this.filterQuery=this.filterQueryInput.value,this.applyClientFilters()}),this.filterFitSelect.addEventListener(`change`,()=>{this.filterFit=this.filterFitSelect.value,this.applyClientFilters()}),this.filterEnrichmentSelect.addEventListener(`change`,()=>{this.filterEnrichment=this.filterEnrichmentSelect.value,this.applyClientFilters()}),this.filterContractSelect.addEventListener(`change`,()=>{this.filterContract=this.filterContractSelect.value,this.applyClientFilters()}),this.filterMatchedProjectSelect.addEventListener(`change`,()=>{this.filterMatchedProject=this.filterMatchedProjectSelect.value,this.applyClientFilters()}),this.filterMinScoreInput.addEventListener(`input`,()=>{this.filterMinScore=this.filterMinScoreInput.value,this.applyClientFilters()}),this.mustQuery(`#dash-refresh-btn`).addEventListener(`click`,()=>{Promise.all([this.loadSearchRuns(),this.loadActiveProjects(),this.loadJobs()])}),this.bulkModeSelect.addEventListener(`change`,()=>this.updateBulkSelectionBar()),this.bulkForceCheckbox.addEventListener(`change`,()=>this.updateBulkSelectionBar()),this.mustQuery(`#dash-clear-selection-btn`).addEventListener(`click`,()=>{this.table.clearSelection()}),this.mustQuery(`#dash-enrich-selected-btn`).addEventListener(`click`,()=>{this.handleBulkEnrichClick()}),this.mustQuery(`#dash-confirm-cancel-btn`).addEventListener(`click`,()=>{this.confirmModalEl.hidden=!0}),this.mustQuery(`#dash-confirm-proceed-btn`).addEventListener(`click`,()=>{this.confirmModalEl.hidden=!0,this.executeBulkEnrich()}),this.batchBannerEl.addEventListener(`click`,e=>{let t=e.target;if(t){if(t.closest(`[data-testid="cancel-batch-btn"]`)){let e=this.activeBatchDetail?.batch.id;e&&this.cancelBatch(e)}else t.closest(`[data-testid="batch-items-toggle"]`)?(this.batchItemsExpanded=!this.batchItemsExpanded,this.renderBatchBanner()):t.closest(`[data-testid="dismiss-batch-banner-btn"]`)&&(this.activeBatchDetail&&(this.batchBannerDismissedId=this.activeBatchDetail.batch.id),this.renderBatchBanner())}})}async requestJson(e,t){let n=await this.transport(e,t);if(this.destroyed)throw Error(`Dashboard destroyed`);if(n.status===401)throw this.stopBatchPolling(),this.onUnauthorized?.(),new ft(401,`Unauthorized (401)`);let r=await n.text();if(this.destroyed)throw Error(`Dashboard destroyed`);let i={};if(r)try{i=JSON.parse(r)}catch{i={}}if(!n.ok){let e=i;throw new ft(n.status,e.error||e.message||`Request failed (${n.status})`)}return i}showError(e){this.errorBannerEl.textContent=e,this.errorBannerEl.hidden=!e}clearError(){this.errorBannerEl.textContent=``,this.errorBannerEl.hidden=!0}async loadWatchersStatus(){if(!this.destroyed)try{let e=await this.requestJson(`/api/watchers/status`,{method:`GET`});if(this.destroyed)return;this.updateWatchersBadge(e)}catch(e){if(pt(e))return}}updateWatchersBadge(e){if(typeof e?.active_rules!=`number`)return;let t=typeof e.paused_rules==`number`?e.paused_rules:0;this.watchersBadgeEl.textContent=t>0?`${e.active_rules} (${t} paused)`:String(e.active_rules),this.watchersBadgeEl.dataset.state=t>0?`paused`:e.active_rules>0?`active`:`idle`}async ensureWatchersPanelInit(){this.destroyed||this.watchersPanelInitialized||(this.watchersPanelInitialized=!0,this.watchersPanel=new dt(this.watchersPanelEl,this.transport,{onUnauthorized:()=>{this.stopBatchPolling(),this.onUnauthorized?.()},onStatusChange:e=>{this.updateWatchersBadge(e)}}),await this.watchersPanel.init())}async loadRuntimeStatus(){if(!this.destroyed){if(this.surface===`web`)try{let e=await this.transport(`/api/health`,{method:`GET`});if(this.destroyed)return;this.wsPillEl.textContent=e.ok?`Daemon Connected`:`Daemon Offline`,this.wsPillEl.dataset.state=e.ok?`connected`:`disconnected`}catch{if(this.destroyed)return;this.wsPillEl.textContent=`Daemon Offline`,this.wsPillEl.dataset.state=`disconnected`}else if(!this.getExtensionRuntimeStatus)this.wsPillEl.textContent=`Extension Ready`,this.wsPillEl.dataset.state=`connected`;else try{let e=await this.getExtensionRuntimeStatus();if(this.destroyed)return;let t=!!e?.wsConnected;this.wsPillEl.textContent=t?`WS Connected`:`WS Offline`,this.wsPillEl.dataset.state=t?`connected`:`disconnected`}catch{if(this.destroyed)return;this.wsPillEl.textContent=`WS Offline`,this.wsPillEl.dataset.state=`disconnected`}}}async loadEnrichmentConfig(){if(!this.destroyed)try{let e=await this.requestJson(`/api/enrichment-config`,{method:`GET`});if(this.destroyed)return;this.config=e,this.bulkModeSelect.value=e.default_mode||`full`,this.bulkForceCheckbox.checked=!!e.default_force,this.bulkModelInput.value=e.default_model||``,this.bulkEffortSelect.value=e.default_effort||``,this.updateBulkSelectionBar()}catch{}}async loadActiveProjects(){if(!this.destroyed)try{let e=await this.requestJson(`/api/active-projects?limit=500`,{method:`GET`});if(this.destroyed)return;this.activeProjects=Array.isArray(e.projects)?e.projects:[];let t=this.activeProjects.filter(e=>e.activity_tier===`active`).length,n=this.activeProjects.filter(e=>e.activity_tier===`recent`).length;this.projectsPillEl.textContent=`${t} active · ${n} recent`;let r=new Set;for(let e of this.activeProjects)e.proposal_visibility===`anonymized`&&(e.public_alias&&r.add(e.public_alias),e.name&&r.add(e.name));this.table.setAnonymizedProjectLabels(r),this.rebuildMatchedProjectFilterOptions()}catch{if(this.destroyed)return;this.projectsPillEl.textContent=`0 active`}}rebuildMatchedProjectFilterOptions(){let e=new Set;for(let t of this.activeProjects){if(t.proposal_visibility===`private`)continue;let n=t.proposal_visibility===`anonymized`?t.public_alias||t.project_key:t.public_alias||t.name||t.project_key;n&&e.add(n)}for(let t of this.allJobs)for(let n of W(t))e.add(n.label);let n=this.filterMatchedProject;this.filterMatchedProjectSelect.innerHTML=`<option value="">All Matched Projects</option>${Array.from(e).sort().map(e=>`<option value="${t(e)}">${t(e)}</option>`).join(``)}`,this.filterMatchedProjectSelect.value=e.has(n)?n:``,this.filterMatchedProject=this.filterMatchedProjectSelect.value}async loadSearchRuns(){if(!this.destroyed)try{let e=await this.requestJson(`/api/search-runs?limit=50`,{method:`GET`});if(this.destroyed)return;this.searchRuns=Array.isArray(e.search_runs)?e.search_runs:[];let n=this.searchRuns.map(e=>{let n=Z(e.id,0),r=Z(e.persisted_count,0),i=t(String(n)),a=t(String(r)),o=Array.isArray(e.queries)?e.queries.join(`, `):``;return`<option value="${i}">#${i} · ${t(String(e.label||o||e.source||``))} (${a})</option>`}).join(``);this.searchRunSelectEl.innerHTML=`<option value="">All Runs</option>${n}`,this.selectedRunId&&(this.searchRunSelectEl.value=this.selectedRunId)}catch{}}async loadJobs(){if(this.destroyed)return;let e=++this.loadJobsSeq;try{let t=new URLSearchParams;t.set(`limit`,`500`),this.selectedRunId&&t.set(`search_run_id`,this.selectedRunId);let n=await this.requestJson(`/api/jobs?${t.toString()}`,{method:`GET`});if(this.destroyed||e!==this.loadJobsSeq)return;this.clearError(),this.allJobs=Array.isArray(n.jobs)?n.jobs:[],this.rebuildMatchedProjectFilterOptions(),this.applyClientFilters();let r=this.drawer.getCurrentJobId();if(r!==null){let e=this.allJobs.find(e=>e.id===r);e&&this.drawer.updateJobIfOpen(e)}}catch(t){if(this.destroyed||e!==this.loadJobsSeq)return;this.showError(t instanceof Error?t.message:`Failed to load jobs`)}}applyClientFilters(){let e=Number.parseFloat(this.filterMinScore),t=this.filterMinScore.trim()!==``&&Number.isFinite(e),n=this.filterFit.trim().toLowerCase(),r=this.filterEnrichment.trim().toLowerCase(),i=this.filterContract.trim().toLowerCase(),a=this.filterMatchedProject.trim().toLowerCase(),o=this.allJobs.filter(o=>!(n&&(o.fit_label??``).toLowerCase()!==n||i&&(o.contract_type??``).toLowerCase()!==i||t&&(o.score??-1)<e||r&&H(o).key!==r||a&&!W(o).some(e=>e.label.toLowerCase()===a)));this.table.setJobs(o),this.table.setGlobalFilter(this.filterQuery),this.updateBulkSelectionBar()}updateBulkSelectionBar(){let e=this.table.getSelectedJobs();if(e.length===0){this.bulkBarEl.hidden=!0;return}this.bulkBarEl.hidden=!1;let t=this.bulkModeSelect.value||`full`,n=this.bulkForceCheckbox.checked,r=e.filter(U).length,i=t===`detail_only`||n?e.length:e.length-r;this.bulkSummaryEl.textContent=`${e.length} selected (${r} already AI-enriched; ${i} will run)`}handleBulkEnrichClick(){let e=this.table.getSelectedJobs();if(e.length===0)return;let t=this.bulkModeSelect.value||`full`,n=this.bulkForceCheckbox.checked,r=e.filter(U).length,i=t===`detail_only`||n?e.length:e.length-r;if(t!==`detail_only`&&(i>this.config.confirm_threshold||i>0&&this.config.confirm_threshold===0)){let e=this.bulkModelInput.value.trim()||this.config.default_model||`(default)`,a=this.bulkEffortSelect.value||this.config.default_effort||`(default)`;this.confirmSummaryEl.textContent=`Run ${t} enrichment for ${i} job(s) (${r} already enriched${n?`, force=true`:` will be skipped`})? Model: ${e} · Effort: ${a}`,this.confirmModalEl.hidden=!1}else this.executeBulkEnrich()}async executeBulkEnrich(){let e=this.table.getSelectedJobIds();if(e.length===0)return;let t=this.bulkModeSelect.value||`full`,n=this.bulkForceCheckbox.checked,r=this.bulkModelInput.value.trim(),i=this.bulkEffortSelect.value;await this.startBatchEnrich(e,{mode:t,force:n,...r?{model:r}:{},...i?{effort:i}:{}})}async startBatchEnrich(e,t){if(this.destroyed)return;let n=++this.batchStateSeq;this.clearError();try{let r={job_ids:e,mode:t?.mode??this.config.default_mode,force:t?.force??this.config.default_force,...t?.model?{model:t.model}:{},...t?.effort?{effort:t.effort}:{},triggered_by:`ui`},i=await this.requestJson(`/api/jobs/enrich`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(r)});if(this.destroyed||n!==this.batchStateSeq)return;this.batchStateSeq+=1,this.isPollInFlight=!1,this.pollTokenCounter+=1,this.batchBannerDismissedId=null,this.activeBatchDetail=i,this.renderBatchBanner(),this.isBatchActive(i.batch)?this.startBatchPolling():this.stopBatchPolling(),await this.loadJobs()}catch(e){if(this.destroyed||n!==this.batchStateSeq)return;this.showError(e instanceof Error?e.message:`Failed to start enrichment batch`)}}isBatchActive(e){return e.status===`queued`||e.status===`running`}async loadActiveBatches(){if(this.destroyed)return;let e=++this.batchStateSeq;try{let t=new URLSearchParams(window.location.search).get(`batch`);if(t&&/^\d+$/.test(t)){let n=await this.requestJson(`/api/enrichment-batches/${t}`,{method:`GET`});if(this.destroyed||e!==this.batchStateSeq)return;this.batchStateSeq+=1,this.isPollInFlight=!1,this.pollTokenCounter+=1,this.activeBatchDetail=n,this.renderBatchBanner(),this.isBatchActive(n.batch)&&this.startBatchPolling();return}let n=await this.requestJson(`/api/enrichment-batches?limit=5`,{method:`GET`});if(this.destroyed||e!==this.batchStateSeq)return;let r=n.batches.find(e=>this.isBatchActive(e));if(r){let t=await this.requestJson(`/api/enrichment-batches/${r.id}`,{method:`GET`});if(this.destroyed||e!==this.batchStateSeq)return;this.batchStateSeq+=1,this.isPollInFlight=!1,this.pollTokenCounter+=1,this.activeBatchDetail=t,this.renderBatchBanner(),this.startBatchPolling()}}catch{}}startBatchPolling(){this.pollTimer!==null||this.destroyed||(this.pollTimer=setInterval(()=>{this.pollBatchTick()},2e3))}stopBatchPolling(){this.pollTimer!==null&&(clearInterval(this.pollTimer),this.pollTimer=null)}async pollBatchTick(){if(this.destroyed||this.isPollInFlight||!this.activeBatchDetail)return;this.isPollInFlight=!0;let e=++this.pollTokenCounter,t=this.batchStateSeq,n=this.activeBatchDetail.batch.id;try{let e=await this.requestJson(`/api/enrichment-batches/${n}`,{method:`GET`});if(this.destroyed||t!==this.batchStateSeq||this.activeBatchDetail?.batch.id!==n||(this.activeBatchDetail=e,this.renderBatchBanner(),await this.loadJobs(),this.destroyed||t!==this.batchStateSeq||this.activeBatchDetail?.batch.id!==n))return;this.isBatchActive(e.batch)||this.stopBatchPolling()}catch(e){if(this.destroyed||t!==this.batchStateSeq||this.activeBatchDetail?.batch.id!==n)return;pt(e)&&(this.stopBatchPolling(),this.showError(e instanceof Error?e.message:`Unauthorized (401)`))}finally{this.pollTokenCounter===e&&(this.isPollInFlight=!1)}}async cancelBatch(e){if(this.destroyed)return;let t=++this.batchStateSeq;try{let n=await this.requestJson(`/api/enrichment-batches/${e}/cancel`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({})});if(this.destroyed||t!==this.batchStateSeq)return;this.batchStateSeq+=1,this.isPollInFlight=!1,this.pollTokenCounter+=1,this.activeBatchDetail=n,this.renderBatchBanner(),this.isBatchActive(n.batch)||this.stopBatchPolling(),await this.loadJobs()}catch(e){if(this.destroyed||t!==this.batchStateSeq)return;this.showError(e instanceof Error?e.message:`Failed to cancel batch`)}}renderBatchBanner(){let e=this.activeBatchDetail,n=e?Z(e.batch.id,0):0;if(!e||this.batchBannerDismissedId===n){this.batchBannerEl.innerHTML=``,this.batchBannerEl.hidden=!0;return}let r=e.batch,i=Z(r.id,0),a=Math.max(0,Z(r.total_count,0)),o=Math.max(0,Z(r.completed_count,0)),s=Math.max(0,Z(r.skipped_count,0)),c=Math.max(0,Z(r.failed_count,0)),l=Math.max(0,Z(r.canceled_count,0)),u=Math.max(0,Z(r.total_tokens_used,0)),d=o+s+c+l,f=a>0?Math.round(d/a*100):0,p=Number.isFinite(f)?Math.max(0,Math.min(100,f)):0,m=this.isBatchActive(r),h=Array.isArray(e.items)?e.items:[],g=this.batchItemsExpanded?`<div class="dash-batch-items">${h.map(e=>{let n=t(String(Z(e.job_id,0))),r=t(String(Math.max(0,Z(e.total_tokens,0))));return`<div class="dash-batch-item-row">
                <span>Job #${n}</span>
                <span>${t(String(e.status??``))}</span>
                <span>${r} tokens</span>
                ${e.error_message?`<span class="dash-err-text">${t(String(e.error_message))}</span>`:``}
              </div>`}).join(``)}</div>`:``,_=t(String(i)),ee=t(String(d)),v=t(String(a)),y=t(String(p)),te=t(String(o)),b=t(String(s)),x=t(String(c)),ne=t(String(l)),S=t(String(u)),C=t(String(h.length));this.batchBannerEl.hidden=!1,this.batchBannerEl.innerHTML=`
      <div class="dash-batch-row">
        <div class="dash-batch-meta">
          <strong>Batch #${_} (${t(String(r.mode??``))}) — ${t(String(r.status??``))}</strong>
          <span>${ee}/${v} (${y}%) · completed ${te} · skipped ${b} · failed ${x} · canceled ${ne} · ${S} tokens</span>
        </div>
        <div class="dash-batch-actions">
          <button type="button" class="dash-btn-sm" data-testid="batch-items-toggle">
            ${this.batchItemsExpanded?`Hide Items`:`Items (${C})`}
          </button>
          ${m?`<button type="button" class="dash-btn-danger" data-testid="cancel-batch-btn">Cancel Remaining</button>`:`<button type="button" class="dash-btn-sm" data-testid="dismiss-batch-banner-btn">Dismiss</button>`}
        </div>
      </div>
      <div class="dash-progress-track"><div class="dash-progress-fill" style="width: ${y}%"></div></div>
      ${g}
    `}async handleRunSearchSubmit(){if(this.destroyed)return;let e=this.mustQuery(`#dash-search-queries`).value.split(/[\n,]+/).map(e=>e.trim()).filter(Boolean),t=this.mustQuery(`#dash-match-active-cb`).checked,n=this.mustQuery(`#dash-search-source`).value||`search`,r=this.mustQuery(`#dash-search-contract`).value,i=this.mustQuery(`#dash-search-rate-min`).value,a=this.mustQuery(`#dash-search-rate-max`).value,o=this.mustQuery(`#dash-search-budget-min`).value,s=this.mustQuery(`#dash-search-budget-max`).value,c=this.mustQuery(`#dash-search-max-pages`).value,l=this.mustQuery(`#dash-search-run-label`).value.trim(),u=this.mustQuery(`#dash-search-payment-verified`).checked,d=this.mustQuery(`#dash-search-panel-status`),f=this.mustQuery(`#dash-run-search-submit`);f.disabled=!0,d.textContent=`Running Upwork search (0 LLM tokens)...`,this.clearError();let p={source:n,skip_auto_detail_enrich:!0,from_active_projects:t,max_pages:Math.max(1,Number.parseInt(c,10)||1),triggered_by:`ui`};e.length===1?p.query=e[0]:e.length>1&&(p.queries=e),r&&(p.contract_type=r),i.trim()&&(p.hourly_rate_min=Number.parseFloat(i)),a.trim()&&(p.hourly_rate_max=Number.parseFloat(a)),o.trim()&&(p.budget_min=Number.parseFloat(o)),s.trim()&&(p.budget_max=Number.parseFloat(s)),u&&(p.payment_verified_only=!0),l&&(p.run_label=l);try{if(this.destroyed)return;let e=await this.requestJson(`/api/jobs/search`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(p)});if(this.destroyed||(d.textContent=`Saved ${e.jobs?.length??0} jobs (${e.stopped_reason??`done`})`,await this.loadSearchRuns(),this.destroyed))return;typeof e.search_run_id==`number`&&Number.isFinite(e.search_run_id)&&e.search_run_id>0&&(this.selectedRunId=String(e.search_run_id),this.searchRunSelectEl.value=this.selectedRunId),await this.loadJobs()}catch(e){if(this.destroyed)return;let t=e instanceof Error?e.message:`Search failed`;d.textContent=t,this.showError(t)}finally{this.destroyed||(f.disabled=!1)}}async handleStatusChange(e,t){if(!this.destroyed)try{let n=await this.requestJson(`/api/jobs/${e}`,{method:`PATCH`,headers:{"Content-Type":`application/json`},body:JSON.stringify({status:t})});if(this.destroyed)return;n.job&&this.mergeUpdatedJob(n.job)}catch(e){if(this.destroyed)return;this.showError(e instanceof Error?e.message:`Failed to update status`)}}async enrichJobFromDrawer(e){if(this.destroyed)return null;let t=this.bulkModelInput.value.trim()||this.config.default_model,n=this.bulkEffortSelect.value||this.config.default_effort,r=await this.requestJson(`/api/jobs/${e.id}/analyze`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({use_llm:!0,ensure_details:!0,...t?{model:t}:{},...n?{effort:n}:{}})});if(this.destroyed)return null;if(r.job){let e=r.llm_error&&!r.job.ai_enrichment_error?{...r.job,ai_enrichment_status:r.job.ai_enrichment_status||`failed`,ai_enrichment_error:r.llm_error}:r.job;return this.mergeUpdatedJob(e),e}return await this.loadJobs(),this.destroyed?null:this.allJobs.find(t=>t.id===e.id)??null}async saveProposalDraftFromDrawer(e){if(this.destroyed)return;if(!e.proposal?.trim())throw Error(`Generate an AI proposal before saving a draft.`);let t={job_id:e.id,...e.upwork_job_id?{upwork_job_id:e.upwork_job_id}:{},cover_letter:e.proposal,bid_type:e.contract_type===`hourly`||e.contract_type===`fixed`?e.contract_type:``,connects_required:e.connects_required??null,portfolio_refs:e.portfolio_references??[],status:`draft`};await this.requestJson(`/api/proposals`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(t)}),this.destroyed}mergeUpdatedJob(e){let t=this.allJobs.findIndex(t=>t.id===e.id);t>=0?this.allJobs[t]=e:this.allJobs.unshift(e),this.applyClientFilters(),this.drawer.updateJobIfOpen(e)}},gt=`upwork_buddy_web_session_token`,Q=`upwork_buddy_web_remember_token`;function _t(){try{let e=window.sessionStorage.getItem(gt);if(e?.trim())return e.trim()}catch{}try{let e=window.localStorage.getItem(Q);if(e?.trim())return e.trim()}catch{}return null}function vt(){try{window.sessionStorage.removeItem(gt)}catch{}try{window.localStorage.removeItem(Q)}catch{}}function yt(e,t){try{window.sessionStorage.setItem(gt,e)}catch{}try{t?window.localStorage.setItem(Q,e):window.localStorage.removeItem(Q)}catch{}}async function bt(e){try{let t=await window.fetch(`/dashboard/auth/exchange`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({ticket:e})});if(!t.ok)return null;let n=await t.json();return typeof n.session_token==`string`&&n.session_token.trim()?n.session_token.trim():null}catch{return null}}async function xt(e){try{let t={Authorization:`Bearer ${e}`},[n,r]=await Promise.all([window.fetch(`/api/health`,{method:`GET`,headers:t}),window.fetch(`/api/enrichment-config`,{method:`GET`,headers:t})]);return n.ok&&r.ok}catch{return!1}}function St(e,t,n){return async(r,i)=>{let a=new Headers(i?.headers);a.set(`Authorization`,`Bearer ${e}`);let o=await window.fetch(r,{...i,headers:a});return o.status===401&&!n?.()&&t(),o}}var $=null;function Ct(e,t,n){e.innerHTML=``,e.hidden=!0,t.hidden=!1,$?.destroy();let r=!1,i=()=>{r||(r=!0,vt(),$?.destroy(),$=null,t.innerHTML=``,t.hidden=!0,wt(e,t,`Session expired or unauthorized (401). Enter your daemon token to continue.`))};$=new ht({root:t,transport:St(n,i,()=>r),surface:`web`,onUnauthorized:i}),$.init()}function wt(e,n,r=``){n.hidden=!0,e.hidden=!1,e.innerHTML=`
    <div class="web-unlock-shell">
      <div class="web-unlock-card">
        <h1>Upwork Buddy</h1>
        <p class="dash-muted">
          Enter your local daemon Bearer token (from <code>~/.config/upwork-buddy/token</code>) to unlock the dashboard.
        </p>
        <form id="web-unlock-form" class="web-unlock-form">
          <label for="web-token-input">
            Daemon Token
            <input
              id="web-token-input"
              name="token"
              type="password"
              data-testid="web-token-input"
              placeholder="Paste Bearer token..."
              autocomplete="off"
              required
            />
          </label>
          <label class="dash-checkbox-inline">
            <input type="checkbox" id="web-remember-checkbox" data-testid="web-remember-checkbox" />
            Remember in this browser (localStorage)
          </label>
          <button type="submit" id="web-unlock-btn" data-testid="web-unlock-btn" class="dash-btn-primary">
            Unlock
          </button>
          <div id="web-unlock-error" data-testid="web-unlock-error" class="dash-banner dash-banner-error" ${r?``:`hidden`}>
            ${t(r)}
          </div>
        </form>
      </div>
    </div>
  `;let i=e.querySelector(`#web-unlock-form`),a=e.querySelector(`#web-token-input`),o=e.querySelector(`#web-remember-checkbox`),s=e.querySelector(`#web-unlock-btn`),c=e.querySelector(`#web-unlock-error`);i?.addEventListener(`submit`,t=>{t.preventDefault(),(async()=>{let t=a?.value.trim()??``;if(!t)return;s&&(s.disabled=!0),c&&(c.textContent=``,c.hidden=!0);let r=await xt(t);s&&(s.disabled=!1),r?(yt(t,!!o?.checked),Ct(e,n,t)):c&&(c.textContent=`Invalid or unauthorized token (401). Please check and try again.`,c.hidden=!1)})()})}async function Tt(){let e=document.getElementById(`web-auth-root`),t=document.getElementById(`dashboard-root`);if(!e||!t)return;let n=new URL(window.location.href),r=n.searchParams.get(`ticket`);if(r){n.searchParams.delete(`ticket`),window.history.replaceState(null,``,n.toString());let i=await bt(r);if(i){yt(i,!1),Ct(e,t,i);return}wt(e,t,`One-time login ticket invalid or expired (401). Enter your daemon token to unlock.`);return}let i=_t();if(i){if(await xt(i)){Ct(e,t,i);return}vt()}wt(e,t)}document.addEventListener(`DOMContentLoaded`,()=>{Tt()});