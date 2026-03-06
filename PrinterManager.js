// ============================================================
// PRINTER MANAGER - Gestiona las impresoras del restaurante
// ============================================================
// Soporta:
//   - 'network'  → Impresora TCP/IP por red (ESC/POS directo)
//   - 'windows'  → Impresora USB/compartida vía Windows (usa el nombre de impresora)
//   - 'none'     → Modo prueba (imprime en consola)

class PrinterManager {
    constructor() {
        this.printers = {};
        this.logs = [];
        this.maxLogs = 200;
    }

    // Registrar una impresora por area
    register(area, config) {
        this.printers[area] = {
            type: config.type || 'none',
            host: config.host,
            port: config.port || 9100,
            name: config.name || '',  // Nombre de impresora Windows (ej: "CAJAP")
            status: 'registrada',
            lastPrint: null,
            printCount: 0,
        };
        const detail = config.type === 'windows' ? `windows: ${config.name}`
            : config.type === 'network' ? `network: ${config.host}:${config.port || 9100}`
                : 'simulado';
        this.log(`📠 Impresora "${area}" registrada (${detail})`);
    }

    // Imprimir texto en la impresora del area indicada
    async print(area, text) {
        const printer = this.printers[area];

        if (!printer) {
            this.log(`⚠️ No hay impresora para area: ${area}`);
            if (this.printers['caja']) {
                this.log(`↪️ Redirigiendo a impresora de caja`);
                return this.print('caja', text);
            }
            return false;
        }

        try {
            if (printer.type === 'network') {
                await this.printNetwork(printer, text);
            } else if (printer.type === 'windows') {
                await this.printWindows(printer, text, area);
            } else if (printer.type === 'none') {
                this.log(`🖨️ [SIMULADO - ${area}] Imprimiendo ${text.length} caracteres`);
                console.log('\n' + '='.repeat(40));
                console.log(`IMPRESION SIMULADA → ${area.toUpperCase()}`);
                console.log('='.repeat(40));
                console.log(text);
                console.log('='.repeat(40) + '\n');
            }

            printer.status = 'ok';
            printer.lastPrint = new Date().toISOString();
            printer.printCount++;
            this.log(`✅ Impreso en ${area} (#${printer.printCount})`);
            return true;
        } catch (error) {
            printer.status = 'error: ' + error.message;
            this.log(`❌ Error imprimiendo en ${area}: ${error.message}`);
            return false;
        }
    }

    // Imprimir por red TCP (ESC/POS directo)
    async printNetwork(printer, text) {
        const net = require('net');

        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            const timeout = setTimeout(() => {
                client.destroy();
                reject(new Error(`Timeout conectando a ${printer.host}:${printer.port}`));
            }, 5000);

            client.connect(printer.port, printer.host, () => {
                clearTimeout(timeout);

                const ESC = '\x1B';
                const GS = '\x1D';
                const commands = [
                    ESC + '@',           // Inicializar
                    ESC + 'a' + '\x01', // Centrar
                    text,
                    '\n\n\n',
                    GS + 'V' + '\x00',  // Cortar papel
                ].join('');

                client.write(commands, () => {
                    client.end();
                    resolve();
                });
            });

            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    // Imprimir por USB/compartida via Windows
    async printWindows(printer, text, area) {
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        const os = require('os');

        const printerName = printer.name;
        if (!printerName) {
            throw new Error('Nombre de impresora Windows no configurado');
        }

        // Escribir datos a archivo temporal con comandos ESC/POS
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `foodly_print_${area}_${Date.now()}.bin`);

        const ESC = '\x1B';
        const GS = '\x1D';
        const rawData = Buffer.from(
            ESC + '@' +           // Inicializar
            ESC + 'a' + '\x01' + // Centrar
            text +
            '\n\n\n' +
            GS + 'V' + '\x00',  // Cortar papel
            'latin1'
        );

        fs.writeFileSync(tmpFile, rawData);
        this.log(`🖨️ [WINDOWS - ${area}] Enviando a "${printerName}"...`);

        return new Promise((resolve, reject) => {
            // Usar PowerShell para enviar raw data a la impresora
            const psCmd = `
                $printer = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name='${printerName.replace(/'/g, "''")}}'"
                if (-not $printer) {
                    # Intentar enviar via copy al puerto compartido
                    Copy-Item '${tmpFile.replace(/'/g, "''")}' -Destination '\\\\localhost\\${printerName.replace(/'/g, "''")}' -Force
                } else {
                    Copy-Item '${tmpFile.replace(/'/g, "''")}' -Destination '\\\\localhost\\${printerName.replace(/'/g, "''")}' -Force
                }
            `.trim();

            // Método más simple y confiable: usar "print" de Windows
            // o copiar directamente al share de la impresora
            const cmd = `copy /b "${tmpFile}" "\\\\localhost\\${printerName}"`;

            exec(cmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
                // Limpiar archivo temporal
                try { fs.unlinkSync(tmpFile); } catch (e) { /* ok */ }

                if (error) {
                    // Si copy falla, intentar con PowerShell Out-Printer
                    const psAlt = `powershell -Command "Get-Content '${tmpFile}' -Raw | Out-Printer -Name '${printerName}'"`;
                    // Intentar método alternativo con raw file
                    const cmd2 = `powershell -Command "$bytes=[System.IO.File]::ReadAllBytes('${tmpFile}'); $port=New-Object System.IO.Ports.SerialPort; $handler=[System.Drawing.Printing.PrintDocument]::new(); $handler.PrinterSettings.PrinterName='${printerName}'"`;

                    // Método directo: usar WMIC
                    this.log(`⚠️ "copy" falló, usa impresora compartida. Error: ${error.message}`);
                    reject(new Error(`No se pudo imprimir en "${printerName}". Comparte la impresora en Windows (click derecho → Propiedades → Compartir → Compartir esta impresora)`));
                    return;
                }

                this.log(`📄 Datos enviados a ${printerName}`);
                resolve();
            });
        });
    }

    // Formatear payload de comanda a texto para impresora termica
    formatComanda(payload) {
        const lines = [];
        const sep = '-'.repeat(42);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = payload.hora || now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

        lines.push('');
        lines.push(`       COMANDA #${payload.comanda}`);
        lines.push(sep);
        lines.push(`Mesa: ${payload.mesa}`);
        lines.push(`Mesero: ${payload.mesero}`);
        if (payload.comensales) lines.push(`Comensales: ${payload.comensales}`);
        lines.push(`Area: ${(payload.area || '').toUpperCase()}`);
        lines.push(`${fecha}  ${hora}`);
        lines.push(sep);

        (payload.items || []).forEach(item => {
            const cant = String(item.cantidad || 1).padStart(2, ' ');
            const nombre = item.nombre || item.producto || 'Sin nombre';
            lines.push(`${cant} x ${nombre}`);
            if (item.comentario) {
                lines.push(`     >> ${item.comentario}`);
            }
        });

        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear factura a texto para impresora termica
    formatFactura(factura) {
        const lines = [];
        const sep = '-'.repeat(42);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

        lines.push('');
        lines.push(`       ${factura.numero_factura || 'FACTURA'}`);
        lines.push(sep);
        lines.push(`Fecha: ${fecha}  ${hora}`);
        lines.push(`Mesa: ${factura.mesa_numero || ''}`);
        lines.push(`Mesero: ${factura.mesero || ''}`);
        lines.push(`Cliente: ${factura.cliente || 'Consumidor final'}`);
        lines.push(sep);

        if (factura.items) {
            lines.push('Cant  Producto                Total');
            lines.push(sep);
            factura.items.forEach(item => {
                const cant = String(item.cantidad || 1).padStart(3, ' ');
                const nombre = (item.nombre || item.plato || '').substring(0, 22).padEnd(22, ' ');
                const total = ((item.precio_unitario || 0) * (item.cantidad || 1)).toLocaleString('es-CO');
                lines.push(`${cant}  ${nombre}  $${total}`);
            });
            lines.push(sep);
        }

        lines.push(`SUBTOTAL:  $${(factura.subtotal || 0).toLocaleString('es-CO')}`);
        if (factura.monto_servicio > 0) lines.push(`SERVICIO:  $${factura.monto_servicio.toLocaleString('es-CO')}`);
        if (factura.monto_iva > 0) lines.push(`IVA:       $${factura.monto_iva.toLocaleString('es-CO')}`);
        if (factura.descuento_monto > 0) lines.push(`DESC:     -$${factura.descuento_monto.toLocaleString('es-CO')}`);
        if (factura.propina > 0) lines.push(`PROPINA:   $${factura.propina.toLocaleString('es-CO')}`);
        lines.push(sep);
        lines.push(`  TOTAL:   $${(factura.total || 0).toLocaleString('es-CO')}`);
        lines.push(sep);
        lines.push(`Pago: ${factura.metodo_pago || ''}`);
        lines.push('');
        lines.push('  Gracias por su visita!');
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear precuenta (verificadora)
    formatPrecuenta(data) {
        const lines = [];
        const sep = '-'.repeat(42);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

        lines.push('');
        lines.push('        *** PRECUENTA ***');
        lines.push(sep);
        if (data.tenant_nombre) lines.push(`  ${data.tenant_nombre}`);
        lines.push(`Fecha: ${fecha}  ${hora}`);
        lines.push(`Mesa: ${data.mesa_numero || ''}`);
        lines.push(`Mesero: ${data.mesero || ''}`);
        lines.push(sep);

        if (data.items) {
            lines.push('Cant  Producto                Total');
            lines.push(sep);
            data.items.forEach(item => {
                const cant = String(item.cantidad || 1).padStart(3, ' ');
                const nombre = (item.nombre || item.plato || '').substring(0, 22).padEnd(22, ' ');
                const total = ((item.precio_unitario || 0) * (item.cantidad || 1)).toLocaleString('es-CO');
                lines.push(`${cant}  ${nombre}  $${total}`);
            });
            lines.push(sep);
        }

        lines.push(`SUBTOTAL:  $${(data.subtotal || 0).toLocaleString('es-CO')}`);
        if (data.monto_servicio > 0) lines.push(`SERVICIO:  $${data.monto_servicio.toLocaleString('es-CO')}`);
        if (data.monto_iva > 0) lines.push(`IVA:       $${data.monto_iva.toLocaleString('es-CO')}`);
        if (data.descuento_mesa > 0) lines.push(`DESC:     -$${data.descuento_mesa.toLocaleString('es-CO')}`);
        lines.push(sep);
        lines.push(`  TOTAL:   $${(data.total || 0).toLocaleString('es-CO')}`);
        lines.push(sep);
        lines.push('');
        lines.push('  ** NO VALIDO COMO FACTURA **');
        lines.push('  Documento de verificacion');
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear cierre de caja
    formatCierreCaja(data) {
        const lines = [];
        const sep = '='.repeat(42);
        const sep2 = '-'.repeat(42);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push('');
        lines.push(sep);
        lines.push('         CIERRE DE CAJA');
        lines.push(sep);
        lines.push(`Cajero: ${data.cajero || ''}`);
        if (data.fecha_apertura) {
            lines.push(`Apertura: ${new Date(data.fecha_apertura).toLocaleString('es-CO')}`);
        }
        lines.push(`Cierre:   ${new Date(data.fecha_cierre || Date.now()).toLocaleString('es-CO')}`);
        lines.push(sep2);

        lines.push('');
        lines.push('VENTAS POR METODO DE PAGO:');
        lines.push(sep2);
        lines.push(`  Efectivo:      $${fmt(data.total_efectivo)}`);
        lines.push(`  Datafono:      $${fmt(data.total_datafono)}`);
        lines.push(`  Transferencia: $${fmt(data.total_transferencia)}`);
        if (data.total_credito > 0) lines.push(`  Credito:       $${fmt(data.total_credito)}`);
        lines.push(sep2);
        lines.push(`  TOTAL VENTAS:  $${fmt(data.total_ventas)}`);

        lines.push('');
        lines.push('PROPINAS:');
        lines.push(sep2);
        if (data.propina_efectivo > 0) lines.push(`  Efectivo:      $${fmt(data.propina_efectivo)}`);
        if (data.propina_datafono > 0) lines.push(`  Datafono:      $${fmt(data.propina_datafono)}`);
        if (data.propina_transferencia > 0) lines.push(`  Transferencia: $${fmt(data.propina_transferencia)}`);
        lines.push(`  TOTAL PROPINAS:$${fmt(data.total_propinas)}`);

        if (data.total_descuentos > 0) {
            lines.push('');
            lines.push(`DESCUENTOS:     -$${fmt(data.total_descuentos)}`);
        }

        lines.push('');
        lines.push(sep);
        lines.push('RESUMEN EFECTIVO:');
        lines.push(sep2);
        lines.push(`  Inicial:    $${fmt(data.efectivo_inicial)}`);
        lines.push(`  + Ventas:   $${fmt(data.total_efectivo)}`);
        lines.push(`  + Propinas: $${fmt(data.propina_efectivo)}`);
        lines.push(sep2);
        lines.push(`  Esperado:   $${fmt(data.efectivo_esperado)}`);
        lines.push(`  Contado:    $${fmt(data.efectivo_contado)}`);
        const dif = Number(data.diferencia) || 0;
        const difLabel = dif >= 0 ? `+$${fmt(dif)}` : `-$${fmt(Math.abs(dif))}`;
        lines.push(`  DIFERENCIA: ${difLabel} ${dif === 0 ? '✓' : dif > 0 ? '(sobrante)' : '(faltante)'}`);

        lines.push('');
        lines.push(sep2);
        lines.push(`Facturas: ${data.num_facturas || 0}`);
        if (data.num_anulaciones > 0) lines.push(`Anulaciones: ${data.num_anulaciones}`);
        if (data.observaciones) {
            lines.push(sep2);
            lines.push(`Obs: ${data.observaciones}`);
        }
        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // Formatear reporte de ventas de productos
    formatReporteVentas(data) {
        const lines = [];
        const sep = '='.repeat(42);
        const sep2 = '-'.repeat(42);
        const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO');

        lines.push('');
        lines.push(sep);
        lines.push('       REPORTE DE VENTAS');
        lines.push(sep);
        lines.push(`Periodo: ${data.desde || ''} a ${data.hasta || ''}`);
        lines.push(`Generado: ${new Date().toLocaleString('es-CO')}`);
        lines.push(sep2);

        // Resumen KPIs
        if (data.resumen) {
            const r = data.resumen;
            lines.push('');
            lines.push('RESUMEN:');
            lines.push(sep2);
            lines.push(`  Facturas:     ${r.total_facturas || 0}`);
            lines.push(`  Venta bruta:  $${fmt(r.venta_bruta)}`);
            if (r.total_descuentos > 0) lines.push(`  Descuentos:  -$${fmt(r.total_descuentos)}`);
            lines.push(`  Venta neta:   $${fmt(r.venta_neta)}`);
            if (r.total_propinas > 0) lines.push(`  Propinas:     $${fmt(r.total_propinas)}`);
            lines.push(`  Ticket prom:  $${fmt(r.ticket_promedio)}`);
            lines.push(`  Comensales:   ${r.total_comensales || 0}`);
        }

        // Productos vendidos
        if (data.productos && data.productos.length > 0) {
            lines.push('');
            lines.push(sep);
            lines.push('PRODUCTOS VENDIDOS:');
            lines.push(sep2);
            lines.push('Cant  Producto          Ingreso');
            lines.push(sep2);

            let totalCant = 0;
            let totalIngreso = 0;
            for (const p of data.productos) {
                const cant = String(p.cantidad || 0).padStart(3, ' ');
                const nombre = (p.nombre || '').substring(0, 16).padEnd(16, ' ');
                const ingreso = (p.ingreso_neto || 0).toLocaleString('es-CO');
                lines.push(`${cant}  ${nombre}  $${ingreso}`);
                totalCant += Number(p.cantidad) || 0;
                totalIngreso += Number(p.ingreso_neto) || 0;
            }
            lines.push(sep2);
            lines.push(`${String(totalCant).padStart(3, ' ')}  ${'TOTAL'.padEnd(16, ' ')}  $${fmt(totalIngreso)}`);
        }

        // Métodos de pago
        if (data.metodos && data.metodos.length > 0) {
            lines.push('');
            lines.push(sep2);
            lines.push('METODOS DE PAGO:');
            lines.push(sep2);
            for (const m of data.metodos) {
                const metodo = (m.metodo || '').substring(0, 16).padEnd(16, ' ');
                lines.push(`  ${metodo} $${fmt(m.total)}`);
            }
        }

        lines.push(sep);
        lines.push(this._footer());

        return lines.join('\n');
    }

    // ── Footer + espacio de corte ──
    _footer() {
        const lines = [];
        lines.push('');
        lines.push('       - - -  Foodly  - - -');
        lines.push('        Carlos Olaya Dev');
        lines.push('         www.foodly.com');
        lines.push('');
        // Espacio para que la impresora avance
        // y la tirilla no se corte antes del footer
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');
        lines.push('');
        return lines.join('\n');
    }

    // Log interno
    log(message) {
        const entry = { time: new Date().toISOString(), msg: message };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) this.logs.pop();
        console.log(`[${entry.time.substring(11, 19)}] ${message}`);
    }

    // Estado de todas las impresoras
    getStatus() {
        return {
            printers: this.printers,
            recentLogs: this.logs.slice(0, 30),
        };
    }
}

module.exports = PrinterManager;
