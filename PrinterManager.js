// ============================================================
// PRINTER MANAGER - Gestiona las impresoras del restaurante
// ============================================================
// Soporta impresoras térmicas ESC/POS por red (network) y
// modo "none" para pruebas sin impresora física.

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
            status: 'registrada',
            lastPrint: null,
            printCount: 0,
        };
        this.log(`📠 Impresora "${area}" registrada (${config.type}: ${config.host || 'local'})`);
    }

    // Imprimir texto en la impresora del area indicada
    async print(area, text) {
        const printer = this.printers[area];

        if (!printer) {
            this.log(`⚠️ No hay impresora para area: ${area}`);
            // Si no hay impresora para el area, intentar con la de caja como fallback
            if (this.printers['caja']) {
                this.log(`↪️ Redirigiendo a impresora de caja`);
                return this.print('caja', text);
            }
            return false;
        }

        try {
            if (printer.type === 'network') {
                await this.printNetwork(printer, text);
            } else if (printer.type === 'none') {
                // Modo prueba: solo loguea
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

    // Imprimir por red TCP (ESC/POS)
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

                // Comandos ESC/POS
                const ESC = '\x1B';
                const GS = '\x1D';
                const commands = [
                    ESC + '@',           // Inicializar impresora
                    ESC + 'a' + '\x01', // Centrar texto
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

    // Formatear payload de comanda a texto para impresora termica
    formatComanda(payload) {
        const lines = [];
        const sep = '-'.repeat(32);

        lines.push('');
        lines.push(`  COMANDA #${payload.comanda}`);
        lines.push(sep);
        lines.push(`Mesa: ${payload.mesa}`);
        lines.push(`Mesero: ${payload.mesero}`);
        if (payload.comensales) lines.push(`Comensales: ${payload.comensales}`);
        lines.push(`Area: ${(payload.area || '').toUpperCase()}`);
        lines.push(`${payload.fecha} ${payload.hora}`);
        lines.push(sep);

        (payload.items || []).forEach(item => {
            const cant = String(item.cantidad).padStart(2, ' ');
            lines.push(`${cant} x ${item.producto}`);
            if (item.comentario) {
                lines.push(`     >> ${item.comentario}`);
            }
        });

        lines.push(sep);
        lines.push('');

        return lines.join('\n');
    }

    // Formatear factura a texto para impresora termica
    formatFactura(factura) {
        const lines = [];
        const sep = '-'.repeat(32);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-CO');
        const hora = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

        lines.push('');
        lines.push(`  ${factura.numero_factura || 'FACTURA'}`);
        lines.push(sep);
        lines.push(`Fecha: ${fecha} ${hora}`);
        lines.push(`Mesa: ${factura.mesa_numero || ''}`);
        lines.push(`Mesero: ${factura.mesero || ''}`);
        lines.push(`Cliente: ${factura.cliente || 'Consumidor final'}`);
        lines.push(sep);

        // Detalle (si viene)
        if (factura.items) {
            lines.push('Cant  Producto          Total');
            lines.push(sep);
            factura.items.forEach(item => {
                const cant = String(item.cantidad || 1).padStart(3, ' ');
                const nombre = (item.plato || item.nombre || '').substring(0, 16).padEnd(16, ' ');
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
